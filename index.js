/**
 * Host half of the Qwen mode bundle.
 *
 * Starts a loopback OpenAI-compatible proxy and maintains dedicated
 * `llm-pi-ai` providers (`From GenieX`, `From QwenCloud`) that point at it.
 * The proxy normalizes Qwen-family thinking parameters, forwards GenieX model
 * load knobs, and rebuilds `reasoning_content` for upstreams that inline their
 * chain of thought.
 *
 * @module dsh-qwen-mode
 */

import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createCapabilityResolver, pairQairtDrafts } from './lib/capabilities.js'
import { createThinkState, rewriteMessage, transformSseEvent } from './lib/reasoning.js'
import {
  clampedNumber,
  httpError,
  isCredentialRef,
  loggerFor,
  mapLimit,
  numberOrNull,
  positiveInt,
  positiveIntOrNull,
  readJson,
  sendJson,
  shortModelName,
  text,
  trimMap,
} from './lib/util.js'

const SCOPE = 'qwen-mode'
const API_PREFIX = '/qwen-mode/api'
const STORE_FILE = 'qwen-mode.json'
const CLIENT_ERROR_LOG = 'qwen-client-errors.log'
const CLIENT_ERROR_LOG_LIMIT = 256 * 1024
const MAX_API_BODY = 512 * 1024
const MAX_PROXY_BODY = 32 * 1024 * 1024
const DEFAULT_PROXY_PORT = 18182
const PROXY_PORT_ATTEMPTS = 8
const DEFAULT_QWEN_CONTEXT = 262144
const DEFAULT_GENIEX_CONTEXT = 131072
// The output cap is a per-request reservation shared with the prompt, so a
// local model needs a prompt budget far larger than its answer budget.
const DEFAULT_MAX_OUTPUT = 16384
const MTP_SPEC_TYPE = 'draft-mtp'
const MTP_DRAFT_TOKENS = 3
const VIT_COMPUTE_VALUE = { cpu: 'CPU', gpu: 'GPU', npu: 'HTP2' }
const PROVIDERS = {
  geniex: { id: 'from-geniex', name: 'From GenieX' },
  qwen: { id: 'from-qwencloud', name: 'From QwenCloud' },
}
const QWEN_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const GENIEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])
/** Model Studio only documents `preserve_thinking` for these generations. */
const PRESERVE_THINKING_PATTERN = /(?:qwen3\.[678]|kimi-k2\.[67])/iu
const MEDIA_PART_TYPES = new Set(['image_url', 'input_image', 'image', 'input_audio', 'audio', 'video', 'video_url'])
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
const SUPPORTED_MODES = ['off', 'auto']
const REPLY_ONLY_KEY = 'reply-only'

const DEFAULTS = {
  upstream: 'http://127.0.0.1:18181',
  maxOutputTokens: DEFAULT_MAX_OUTPUT,
  mtpDraftTokens: MTP_DRAFT_TOKENS,
  vitCompute: 'npu',
}

/** Services required by the proxy, provider maintenance, and settings API. */
export const inject = ['webServer', 'connection', 'configEditor', 'credentials', 'permissionPresets', 'sessions', 'agents', 'tools']

function normalizeUpstream(value) {
  const candidate = text(value).replace(/\/+$/u, '')
  try {
    const url = new URL(candidate)
    if (url.protocol === 'http:' || url.protocol === 'https:') return candidate
  } catch {
    // Fall through to the default.
  }
  return DEFAULTS.upstream
}

function assertUpstream(value) {
  try {
    const url = new URL(text(value))
    if (url.protocol === 'http:' || url.protocol === 'https:') return
  } catch {
    // Reported below.
  }
  throw httpError(400, 'Upstream URL must be an absolute http(s) URL')
}

/** An invalid reference is dropped on load and rejected on save. */
function normalizeApiKeyRef(value) {
  const ref = text(value)
  return ref === '' || isCredentialRef(ref) ? ref : ''
}

function assertApiKeyRef(value) {
  const ref = text(value)
  if (ref !== '' && !isCredentialRef(ref)) {
    throw httpError(400, 'API key reference must be an environment variable name (letters, digits, underscore)')
  }
}

function integerOrNull(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, Math.round(value)))
}

function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const protocol = source.protocol === 'qwen' ? 'qwen' : 'geniex'
  const proxyPort = positiveIntOrNull(source.proxyPort)
  const contextWindow = positiveIntOrNull(source.contextWindow)
  const maxOutput = positiveInt(source.maxOutputTokens, DEFAULTS.maxOutputTokens)
  const ceiling = contextWindow ?? (protocol === 'qwen' ? DEFAULT_QWEN_CONTEXT : null)
  return {
    version: 1,
    mode: SUPPORTED_MODES.includes(source.mode) ? source.mode : source.enabled === true || source.mode === 'always' ? 'auto' : 'off',
    warm: source.warm === true,
    protocol,
    upstream: normalizeUpstream(source.upstream),
    apiKeyEnv: normalizeApiKeyRef(source.apiKeyEnv),
    proxyPort: proxyPort !== null && proxyPort < 65536 ? proxyPort : DEFAULT_PROXY_PORT,
    managedProviderId: text(source.managedProviderId) || null,
    contextWindow,
    maxOutputTokens: ceiling === null ? maxOutput : Math.min(maxOutput, ceiling),
    autoNctx: source.autoNctx === true,
    mtp: source.mtp === true,
    mtpDraftTokens: integerOrNull(source.mtpDraftTokens, 1, 64) ?? DEFAULTS.mtpDraftTokens,
    mtpDraftMin: integerOrNull(source.mtpDraftMin, 0, 64) ?? 0,
    mtpDraftPMin: clampedNumber(source.mtpDraftPMin, 0, 1) ?? 0,
    compute: text(source.compute).slice(0, 100),
    vitCompute: ['cpu', 'gpu', 'npu'].includes(source.vitCompute) ? source.vitCompute : DEFAULTS.vitCompute,
    temperature: clampedNumber(source.temperature, 0, 2),
    topP: clampedNumber(source.topP, 0, 1),
    topK: integerOrNull(source.topK, 0, 1000),
    minP: clampedNumber(source.minP, 0, 1),
    repetitionPenalty: clampedNumber(source.repetitionPenalty, 0, 5),
    presencePenalty: clampedNumber(source.presencePenalty, -2, 2),
    frequencyPenalty: clampedNumber(source.frequencyPenalty, -2, 2),
    lastError: text(source.lastError) || null,
  }
}

function providerIdFor(protocol) {
  return protocol === 'qwen' ? PROVIDERS.qwen.id : PROVIDERS.geniex.id
}

function providerNameFor(protocol) {
  return protocol === 'qwen' ? PROVIDERS.qwen.name : PROVIDERS.geniex.name
}

function apiKeyRef(settings) {
  return text(settings.apiKeyEnv) || 'local'
}

function proxyBaseURL(port) {
  return `http://127.0.0.1:${port}/v1`
}

/** Build the upstream endpoint for one documented API path. */
function upstreamURL(settings, path) {
  const base = new URL(settings.upstream)
  let pathname = base.pathname.replace(/\/+$/u, '')
  if (settings.protocol === 'geniex' && !pathname.endsWith('/v1')) pathname += '/v1'
  base.pathname = `${pathname}/${path}`
  base.search = ''
  base.hash = ''
  return base
}

/** Map a proxy request URL onto the upstream base path. */
function upstreamRequestURL(settings, requestUrl) {
  const base = new URL(settings.upstream)
  const basePath = base.pathname.replace(/\/+$/u, '')
  let requestPath = requestUrl.pathname
  if (basePath.endsWith('/v1') && (requestPath === '/v1' || requestPath.startsWith('/v1/'))) {
    requestPath = requestPath.slice(3) || '/'
  }
  return new URL(`${basePath}${requestPath}${requestUrl.search}`, base)
}

/**
 * The context window one model request and its provider entry both use.
 *
 * GenieX loads with `nctx` explicitly, so the value advertised to DSH must be
 * the same number: over-claiming makes DSH skip compaction until the upstream
 * rejects the prompt, under-claiming compacts far too early.
 */
function effectiveContext(settings, metadataContext) {
  const metadata = positiveIntOrNull(metadataContext)
  // "Prefer model context limit" overrides an explicit value; otherwise an
  // explicit setting is the user's override and wins over the model metadata.
  if (metadata !== null && settings.autoNctx) return metadata
  if (settings.contextWindow !== null) return settings.contextWindow
  if (metadata !== null) return metadata
  return settings.protocol === 'qwen' ? DEFAULT_QWEN_CONTEXT : DEFAULT_GENIEX_CONTEXT
}

function requestedEffort(body) {
  return typeof body?.reasoning_effort === 'string' ? body.reasoning_effort.trim().toLowerCase() : ''
}

/** Whether one request body asks the model to think. */
function thinkingEnabled(body) {
  const effort = requestedEffort(body)
  if (effort !== '') return !['off', 'none'].includes(effort)
  if (typeof body.enable_think === 'boolean') return body.enable_think
  if (typeof body.enable_thinking === 'boolean') return body.enable_thinking
  return true
}

function inferenceFields(settings, vision) {
  const fields = {}
  if (settings.compute !== '') fields.compute = settings.compute
  if (vision) fields.vit_compute = VIT_COMPUTE_VALUE[settings.vitCompute]
  return fields
}

function loadFields(settings, context, mtp, mtpDraft) {
  const fields = {}
  if (settings.protocol !== 'geniex') return fields
  if (typeof context === 'number' && context > 0) fields.nctx = context
  if (mtp === true && mtpDraft !== '') {
    fields.spec_type = MTP_SPEC_TYPE
    fields.spec_draft_model = mtpDraft
    fields.spec_n_max = settings.mtpDraftTokens
    fields.spec_n_min = settings.mtpDraftMin
    fields.spec_p_min = settings.mtpDraftPMin
  }
  return fields
}

/**
 * Apply Qwen-family thinking parameters and GenieX load knobs to one request.
 * @param body - parsed request body.
 * @param settings - current settings snapshot.
 * @param options - thinking, vision, context, and MTP decisions.
 */
function applyRequestDefaults(body, settings, options) {
  const output = { ...body }
  delete output.nctx
  for (const key of Object.keys(output)) {
    if (key.startsWith('spec_')) delete output[key]
  }
  const qwen = settings.protocol === 'qwen'
  if (qwen) {
    delete output.enable_think
    delete output.compute
    delete output.vit_compute
    delete output.ngl
    delete output.power_mode
    delete output.reasoning_format
    delete output.min_p
    if (options.reasoning === false) {
      delete output.enable_thinking
      delete output.preserve_thinking
      delete output.reasoning_effort
    } else {
      output.enable_thinking = options.thinking
      if (options.thinking && typeof body.model === 'string' && PRESERVE_THINKING_PATTERN.test(body.model)) {
        output.preserve_thinking = true
      } else {
        delete output.preserve_thinking
      }
      const effort = requestedEffort(body)
      // Model Studio accepts only its documented levels; the family table's
      // `enabled` spelling for on/off is not one of them and would 400.
      if (options.thinking && QWEN_REASONING_EFFORTS.has(effort)) output.reasoning_effort = effort
      else delete output.reasoning_effort
    }
  } else {
    output.enable_think = options.thinking
    delete output.enable_thinking
    delete output.preserve_thinking
    const effort = requestedEffort(body)
    if (options.thinking && GENIEX_REASONING_EFFORTS.has(effort)) output.reasoning_effort = effort
    else delete output.reasoning_effort
    output.reasoning_format = 'auto'
    Object.assign(output, inferenceFields(settings, options.vision))
    Object.assign(output, loadFields(settings, options.context, options.mtp, options.mtpDraft))
  }
  // Both protocols share one window between prompt and completion.
  if (typeof options.context === 'number' && options.context > 0) {
    for (const key of ['max_completion_tokens', 'max_tokens']) {
      if (typeof output[key] === 'number' && output[key] > options.context) output[key] = options.context
    }
  }
  const fill = (key, value) => {
    if (value !== null && output[key] === undefined) output[key] = value
  }
  fill('temperature', settings.temperature)
  fill('top_p', settings.topP)
  fill('top_k', settings.topK)
  // `min_p` is a llama.cpp sampler; Model Studio documents no such parameter.
  if (!qwen) fill('min_p', settings.minP)
  fill('repetition_penalty', settings.repetitionPenalty)
  fill('presence_penalty', settings.presencePenalty)
  fill('frequency_penalty', settings.frequencyPenalty)
  if (output.stream === true) {
    output.stream_options = {
      ...(output.stream_options !== null && typeof output.stream_options === 'object' ? output.stream_options : {}),
      include_usage: true,
    }
  }
  return output
}

/** Whether a request carries any media part that takes GenieX's VLM path. */
function bodyHasMedia(body) {
  if (!Array.isArray(body?.messages)) return false
  return body.messages.some((message) => {
    if (!Array.isArray(message?.content)) return false
    return message.content.some((part) => typeof part?.type === 'string' && MEDIA_PART_TYPES.has(part.type.toLowerCase()))
  })
}

/** The first streamed token's timestamp, whichever record carries it. */
function streamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record?.type === 'chunk') {
      const type = record.chunk?.type
      if (type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta') return record.time
      continue
    }
    if (record?.type === 'text-chunks' || record?.type === 'reasoning-chunks') {
      if (Array.isArray(record.texts) && record.texts.some((value) => value !== '')) return record.time0
      continue
    }
    if (record?.type === 'tool-call-chunks' && record.name !== undefined) return record.time0
  }
  return undefined
}

/** Build the compact UI metric for one settled assistant message. */
function buildTurnMetric(event, first, start) {
  const source = event.data?.message?.source
  if (typeof source?.provider !== 'string' || typeof source?.model !== 'string') return null
  const outputTokens = event.data?.usage?.outputTokens ?? null
  const ttftMs = Math.max(0, Math.round(first - start))
  const decodeMs = Math.max(1, event.time - first)
  return {
    provider: source.provider,
    model: source.model,
    ttftMs,
    tps: outputTokens === null ? null : Math.round(outputTokens / (decodeMs / 1000) * 10) / 10,
    outputTokens,
  }
}

function userError(message) {
  return message instanceof Error ? message.message : String(message)
}

/** Merge inherited and profile-layer provider maps. */
function providerMap(inherited, current) {
  return {
    ...((inherited ?? {}).providers ?? {}),
    ...((current ?? {}).providers ?? {}),
  }
}

/** Find the loader entry that owns the `llm-pi-ai` provider table. */
function findLlmEntry(ctx) {
  return ctx.configEditor.entries().find((entry) => {
    return entry.options?.id === 'llm-pi-ai' || entry.id?.endsWith(':llm-pi-ai')
  })
}

function readProviderConfig(ctx) {
  const entry = findLlmEntry(ctx)
  if (entry === undefined) throw httpError(400, 'llm-pi-ai entry not found')
  const row = ctx.configEditor.configuration().find((candidate) => candidate.entry === entry)
  const merged = { ...(row?.inherited ?? {}), ...(row?.override ?? {}) }
  const providers = merged.providers !== null && typeof merged.providers === 'object' ? merged.providers : {}
  return { editor: ctx.configEditor, entry, providers }
}

/** Merge a change into the provider table through one config edit. */
async function editProviders(ctx, change) {
  const { editor, entry } = readProviderConfig(ctx)
  await editor.edit(entry, (current, inherited) => {
    const config = { ...(inherited ?? {}), ...(current ?? {}) }
    const providers = providerMap(inherited, current)
    change(providers)
    return { ...config, providers }
  })
}

async function credentialHeader(ctx, settings) {
  try {
    const value = (await ctx.credentials.resolve(apiKeyRef(settings)))?.value ?? ''
    return value === '' ? {} : { authorization: `Bearer ${value}` }
  } catch {
    return {}
  }
}

async function ensureLocalCredential(ctx) {
  try {
    // `resolve` reports a missing reference as undefined, not as a throw.
    const value = (await ctx.credentials.resolve('local'))?.value ?? ''
    if (value !== '') return
    await ctx.credentials.set('local', 'local')
  } catch (error) {
    runtime.logger?.warn?.(`[${SCOPE}] cannot store the local credential: ${userError(error)}`)
  }
}

/** Build one provider model entry from resolved capabilities. */
function buildModelSpec(settings, id, capability) {
  const metadataContext = positiveIntOrNull(capability?.contextLength)
  const contextWindow = effectiveContext(settings, metadataContext)
  const declaredMaxOutput = positiveIntOrNull(capability?.maxOutput)
  const model = {
    id,
    name: shortModelName(id),
    maxTokens: Math.max(1, Math.min(settings.maxOutputTokens, declaredMaxOutput ?? Number.MAX_SAFE_INTEGER, contextWindow)),
    contextWindow,
    input: capability?.vision === true ? ['text', 'image'] : ['text'],
  }
  if (capability?.reasoningEfforts !== undefined) model.reasoningEfforts = capability.reasoningEfforts
  return model
}

/**
 * Discover the upstream catalog and resolve every model's capabilities.
 *
 * Paired MTP drafts are hidden from the chat catalog: GenieX's documented MTP
 * setup pulls an assistant model alongside its target, and offering it as a
 * chat model only produces confusing failures.
 */
async function discoverModels(ctx, settings, capabilities) {
  if (settings.protocol === 'qwen') {
    // Model Studio's compatible base URL has no /models endpoint; its catalog
    // lives under /api/v1/models and also reports context and modalities.
    const listed = await capabilities.listQwenModels(settings)
    if (listed.size > 0) {
      const models = [...listed].map(([id, capability]) => buildModelSpec(settings, id, capability))
      return { models, capabilities: listed, qairtDrafts: new Map() }
    }
  }
  const url = upstreamURL(settings, 'models')
  const headers = { accept: 'application/json', ...await credentialHeader(ctx, settings) }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw httpError(502, `model discovery failed: HTTP ${response.status}`)
  const body = await response.json()
  const rows = Array.isArray(body?.data) ? body.data : []
  const ids = [...new Set(rows.map((row) => (typeof row?.id === 'string' ? row.id.trim() : '')).filter((id) => id !== ''))]
  if (ids.length === 0) throw httpError(502, 'model discovery returned no models')
  const resolved = new Map()
  await mapLimit(ids, 4, async (id) => {
    resolved.set(id, await capabilities.resolve(settings, id))
  })
  // Only QAIRT models pair with a separately cached assistant companion; a
  // GGUF model's draft is its own injected `mtp-*.gguf` file.
  const qairtDrafts = pairQairtDrafts(ids, resolved)
  for (const [draftId, targetId] of qairtDrafts) {
    const target = resolved.get(targetId)
    if (target === undefined || target === null) continue
    resolved.set(targetId, { ...target, mtpDraft: draftId, mtpReady: true })
  }
  const models = []
  const kept = new Map()
  for (const id of ids) {
    // A paired assistant is a draft, not a chat model.
    if (qairtDrafts.has(id)) continue
    const capability = resolved.get(id) ?? null
    models.push(buildModelSpec(settings, id, capability))
    kept.set(id, capability)
  }
  return { models, capabilities: kept, qairtDrafts }
}

async function upsertProvider(ctx, settings) {
  const keyRef = apiKeyRef(settings)
  if (keyRef === 'local') await ensureLocalCredential(ctx)
  const { models, capabilities, qairtDrafts } = await discoverModels(ctx, settings, runtimeCapabilities(ctx))
  const id = providerIdFor(settings.protocol)
  const desired = {
    displayName: providerNameFor(settings.protocol),
    api: 'openai-completions',
    baseURL: proxyBaseURL(settings.proxyPort),
    apiKeyEnv: keyRef,
    compat: {
      thinkingFormat: 'qwen',
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_completion_tokens',
    },
    models,
  }
  const previous = settings.managedProviderId
  await editProviders(ctx, (providers) => {
    if (previous !== null && previous !== id) delete providers[previous]
    providers[id] = desired
  })
  settings.managedProviderId = id
  settings.lastError = null
  try {
    ctx.emit('llm/models-updated', id)
    ctx.emit('llm/adapters-updated')
  } catch {
    // Catalog refresh is best-effort; the provider config is already committed.
  }
  return {
    id,
    displayName: desired.displayName,
    baseURL: desired.baseURL,
    models: models.map((model) => model.id),
    visionModels: models.filter((model) => model.input.includes('image')).map((model) => model.id),
    capabilities,
    qairtDrafts,
    entries: models,
  }
}

async function deleteProvider(ctx, id) {
  if (id === null) return
  await editProviders(ctx, (providers) => {
    delete providers[id]
  })
  try {
    ctx.emit('llm/models-updated', id)
  } catch {
    // Catalog refresh is best-effort.
  }
}

function readManagedProvider(ctx, settings) {
  try {
    const { providers } = readProviderConfig(ctx)
    const id = settings.managedProviderId
    const provider = id === null ? undefined : providers[id]
    return {
      provider: id === null ? null : {
        id,
        displayName: provider?.displayName ?? providerNameFor(settings.protocol),
        baseURL: provider?.baseURL ?? '',
        exists: provider !== undefined,
        models: Array.isArray(provider?.models) ? provider.models.map((model) => model?.id).filter((value) => typeof value === 'string') : [],
        visionModels: Array.isArray(provider?.models)
          ? provider.models.filter((model) => Array.isArray(model?.input) && model.input.includes('image')).map((model) => model.id)
          : [],
        entries: Array.isArray(provider?.models) ? provider.models : [],
      },
    }
  } catch {
    return { provider: null }
  }
}

/** Create the mutable state shared by the API, proxy, and background sync. */
function createRuntime() {
  return {
    settings: normalizeSettings({}),
    profileDir: '',
    storePath: '',
    logger: null,
    capabilities: null,
    managedModels: new Set(),
    visionModels: new Set(),
    qairtDrafts: new Map(),
    qairtDraftsKey: '',
    mtpModels: new Set(),
    mtpDrafts: new Map(),
    modelContexts: new Map(),
    modelCapabilities: new Map(),
    modelReasoning: new Map(),
    capabilitySignature: '',
    modelRevision: 0,
    capabilityRetryAt: 0,
    managedRefresh: null,
    managedRefreshKey: '',
    stateCache: null,
    statusCache: { key: '', at: 0, value: null },
    turnMetrics: new Map(),
    sessionProviders: new Set(),
    stepStarts: new Map(),
    firstTokens: new Map(),
    derivedSessions: new Set(),
    deriving: new Map(),
    mtpSuppressed: new Set(),
    mtpApproved: new Set(),
    mtpStats: new Map(),
    warmingModels: new Set(),
    warmQueue: Promise.resolve(),
    warmGeneration: 0,
    bindError: null,
    replyRestrictions: new Map(),
    startupTimer: null,
  }
}

let runtime = createRuntime()
let providerChain = Promise.resolve()
let persistChain = Promise.resolve()

function invalidateState() {
  runtime.stateCache = null
}

/** Apply one provider snapshot to the managed model sets. */
function applyManagedProvider(provider) {
  runtime.managedModels.clear()
  runtime.visionModels.clear()
  runtime.modelReasoning.clear()
  for (const id of provider?.models ?? []) runtime.managedModels.add(id)
  for (const id of provider?.visionModels ?? []) runtime.visionModels.add(id)
  // The provider entry already records each model's thinking capability, so a
  // restart keeps the per-family decision until capabilities are re-resolved.
  for (const model of provider?.entries ?? []) {
    if (typeof model?.id !== 'string') continue
    if (model.reasoningEfforts === false) runtime.modelReasoning.set(model.id, false)
    else if (model.reasoningEfforts !== undefined) runtime.modelReasoning.set(model.id, true)
  }
}

/** Rebuild the capability-derived sets; returns whether anything changed. */
function applyCapabilities(capabilities) {
  // QAIRT assistant pairs are discovered from the upstream catalog, so they are
  // re-applied here; a refresh from local metadata must not lose them.
  if (runtime.qairtDraftsKey === `${runtime.settings.protocol}|${runtime.settings.upstream}`) {
    for (const [draftId, targetId] of runtime.qairtDrafts) {
      const target = capabilities.get(targetId)
      if (target === undefined || target === null) continue
      capabilities.set(targetId, { ...target, mtpDraft: draftId, mtpReady: true })
    }
  }
  const signature = JSON.stringify([...capabilities]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([id, capability]) => [
      id,
      capability?.contextLength ?? null,
      capability?.maxOutput ?? null,
      capability?.vision ?? null,
      capability?.reasoningEfforts ?? null,
      capability?.mtpDraft ?? null,
      capability?.mtpReady ?? null,
      capability?.hasMtp ?? null,
      capability?.tags ?? null,
      capability?.sampling ?? null,
    ]))
  runtime.mtpModels.clear()
  runtime.mtpDrafts.clear()
  runtime.modelContexts.clear()
  runtime.modelCapabilities.clear()
  for (const [id, capability] of capabilities) {
    runtime.modelCapabilities.set(id, capability)
    if (capability?.mtpReady === true && typeof capability?.mtpDraft === 'string' && capability.mtpDraft !== '') {
      runtime.mtpModels.add(id)
      runtime.mtpDrafts.set(id, capability.mtpDraft)
    }
    if (positiveIntOrNull(capability?.contextLength) !== null) runtime.modelContexts.set(id, capability.contextLength)
  }
  const changed = signature !== runtime.capabilitySignature
  runtime.capabilitySignature = signature
  return changed
}

function runtimeCapabilities(ctx) {
  if (runtime.capabilities === null) {
    runtime.capabilities = createCapabilityResolver({
      authHeaders: (settings) => credentialHeader(ctx, settings),
      logger: runtime.logger,
    })
  }
  return runtime.capabilities
}

/** Resolve capabilities for every managed model and refresh both catalogs. */
function refreshManagedModels(ctx, force = false) {
  const snapshot = { ...runtime.settings }
  const key = [snapshot.mode, snapshot.protocol, snapshot.upstream, snapshot.managedProviderId].join('|')
  if (!force && runtime.managedRefresh !== null && runtime.managedRefreshKey === key) return runtime.managedRefresh
  const promise = (async () => {
    const provider = readManagedProvider(ctx, snapshot).provider
    const capabilities = new Map()
    if (snapshot.protocol === 'geniex') {
      const ids = provider?.models ?? []
      await mapLimit(ids, 4, async (id) => {
        capabilities.set(id, await runtimeCapabilities(ctx).resolve(snapshot, id))
      })
    }
    const current = [runtime.settings.mode, runtime.settings.protocol, runtime.settings.upstream, runtime.settings.managedProviderId].join('|')
    if (current !== key) return
    applyManagedProvider(provider)
    if (snapshot.protocol === 'geniex' && applyCapabilities(capabilities)) runtime.modelRevision += 1
    invalidateState()
  })().finally(() => {
    if (runtime.managedRefresh === promise) {
      runtime.managedRefresh = null
      runtime.managedRefreshKey = ''
    }
  })
  runtime.managedRefresh = promise
  runtime.managedRefreshKey = key
  return promise
}

/** Serialize provider-config writes with background refreshes. */
function providerTask(operation) {
  const run = providerChain.then(operation, operation)
  providerChain = run.then(() => undefined, () => undefined)
  return run
}

/** Rebuild or remove the managed provider for the current settings. */
function syncProvider(ctx) {
  return providerTask(async () => {
    invalidateState()
    const settings = runtime.settings
    if (settings.mode === 'off') {
      await deleteProvider(ctx, settings.managedProviderId)
      settings.managedProviderId = null
      runtime.qairtDrafts = new Map()
      runtime.qairtDraftsKey = ''
      applyManagedProvider(null)
      if (applyCapabilities(new Map())) runtime.modelRevision += 1
      invalidateState()
      return
    }
    const provider = await upsertProvider(ctx, settings)
    runtime.qairtDrafts = provider.qairtDrafts ?? new Map()
    runtime.qairtDraftsKey = `${settings.protocol}|${settings.upstream}`
    applyManagedProvider(provider)
    if (applyCapabilities(provider.capabilities)) runtime.modelRevision += 1
    invalidateState()
  })
}

function canMtp(model) {
  return runtime.settings.mtp
    && runtime.settings.protocol === 'geniex'
    && runtime.mtpModels.has(model)
    && runtime.mtpDrafts.has(model)
}

function useMtp(model) {
  return canMtp(model) && !runtime.mtpSuppressed.has(model)
}

function mtpDraftFor(model) {
  return runtime.mtpDrafts.get(model) ?? ''
}

function consumeMtpChoice(model) {
  runtime.mtpApproved.delete(model)
  runtime.mtpSuppressed.delete(model)
}

function recordMtpUsage(model, usage, active) {
  if (!active) return
  const details = usage?.completion_tokens_details ?? usage?.completionTokensDetails
  const accepted = numberOrNull(details?.accepted_prediction_tokens ?? details?.acceptedPredictionTokens)
  const rejected = numberOrNull(details?.rejected_prediction_tokens ?? details?.rejectedPredictionTokens)
  if (accepted === null || rejected === null || accepted + rejected <= 0) return
  runtime.mtpStats.set(model, {
    accepted,
    rejected,
    rate: accepted / (accepted + rejected),
    updatedAt: Date.now(),
  })
  trimMap(runtime.mtpStats, 64)
}

function ownsModel(model) {
  return runtime.settings.mode === 'auto' && typeof model === 'string' && runtime.managedModels.has(model)
}

function modelLoadContext(model) {
  return effectiveContext(runtime.settings, runtime.modelContexts.get(model) ?? null)
}

/** The thinking capability of one managed model: true, false, or undefined. */
function modelReasoning(model) {
  const value = runtime.modelCapabilities.get(model)?.reasoningEfforts
  if (value === false) return false
  if (value !== undefined) return true
  return runtime.modelReasoning.get(model)
}

/** Store one turn's timing and token counts. */
function recordTurn(sessionId, turn, metric) {
  runtime.turnMetrics.set(`${sessionId}:${turn}`, metric)
  trimMap(runtime.turnMetrics, 2000)
  if (metric.provider !== PROVIDERS.geniex.id) return
  runtime.sessionProviders.add(sessionId)
  while (runtime.sessionProviders.size > 2000) {
    const oldest = runtime.sessionProviders.values().next().value
    if (oldest === undefined) break
    runtime.sessionProviders.delete(oldest)
  }
}

/** Replay one restored session's stream records into turn metrics. */
function deriveSessionMetrics(session) {
  if (runtime.derivedSessions.has(session.id)) return Promise.resolve()
  const inFlight = runtime.deriving.get(session.id)
  if (inFlight !== undefined) return inFlight
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return Promise.resolve()
  }
  const promise = (async () => {
    const starts = new Map()
    const firsts = new Map()
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      const turn = event.data?.turn
      const step = event.data?.step
      if (Number.isInteger(turn) && Number.isInteger(step)) {
        const key = `${turn}:${step}`
        if (event.type === 'step/start') {
          starts.set(key, event.time)
        } else if (event.type === 'assistant/attempt') {
          const first = streamFirstTokenTime(event.data.stream)
          if (first !== undefined) firsts.set(key, first)
        } else if (event.type === 'assistant/message') {
          const first = firsts.get(key) ?? streamFirstTokenTime(event.data.stream) ?? event.time
          const metric = buildTurnMetric(event, first, starts.get(key) ?? first)
          if (metric !== null) recordTurn(session.id, turn, metric)
        }
      }
      if (index % 400 === 399) await new Promise((resolve) => setImmediate(resolve))
    }
    runtime.derivedSessions.add(session.id)
    while (runtime.derivedSessions.size > 200) {
      const oldest = runtime.derivedSessions.values().next().value
      if (oldest === undefined) break
      runtime.derivedSessions.delete(oldest)
    }
  })().finally(() => {
    runtime.deriving.delete(session.id)
  })
  runtime.deriving.set(session.id, promise)
  return promise
}

/** Stream one upstream response to the client, rewriting reasoning fields. */
function writeProxyResponse(upstream, res, { active, onUsage }) {
  const headers = { ...upstream.headers }
  for (const name of [...HOP_BY_HOP, 'content-length', 'transfer-encoding']) delete headers[name]
  headers['cache-control'] = 'no-store'
  try {
    res.writeHead(upstream.statusCode ?? 502, headers)
    res.flushHeaders?.()
  } catch {
    upstream.destroy()
    return
  }
  res.socket?.setNoDelay(true)

  const contentType = String(upstream.headers['content-type'] ?? '')
  const streaming = contentType.includes('text/event-stream')
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  upstream.on('error', () => res.destroy())
  upstream.on('aborted', () => res.destroy())

  if (!active || (!streaming && !contentType.includes('application/json'))) {
    upstream.pipe(res)
    return
  }

  const end = (value) => {
    if (res.writableEnded) return
    try {
      res.end(value)
    } catch {
      res.destroy()
    }
  }

  if (!streaming) {
    const chunks = []
    upstream.on('data', (chunk) => chunks.push(chunk))
    upstream.on('end', () => {
      const raw = Buffer.concat(chunks)
      let payload
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        end(raw)
        return
      }
      onUsage?.(payload?.usage)
      if (Array.isArray(payload.choices)) {
        payload.choices = payload.choices.map((choice) => ({ ...choice, message: rewriteMessage(choice.message) }))
      }
      end(JSON.stringify(payload))
    })
    return
  }

  const decoder = new StringDecoder('utf8')
  const state = createThinkState()
  const meta = { onUsage }
  let buffer = ''
  const write = (value) => {
    if (value === '' || res.writableEnded) return
    try {
      if (!res.write(value)) {
        upstream.pause()
        res.once('drain', () => upstream.resume())
      }
    } catch {
      upstream.destroy()
    }
  }
  upstream.on('data', (chunk) => {
    buffer += decoder.write(chunk)
    while (true) {
      const lf = buffer.indexOf('\n\n')
      const crlf = buffer.indexOf('\r\n\r\n')
      let index = -1
      let width = 2
      if (crlf !== -1 && (lf === -1 || crlf < lf)) {
        index = crlf
        width = 4
      } else if (lf !== -1) {
        index = lf
      } else {
        break
      }
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + width)
      write(transformSseEvent(raw, state, meta))
    }
  })
  upstream.on('end', () => {
    buffer += decoder.end()
    if (buffer.trim() !== '') write(transformSseEvent(buffer, state, meta))
    end()
  })
}

/** Forward one proxy request to the configured upstream. */
function handleProxyRequest(req, res) {
  const settings = runtime.settings
  const logger = runtime.logger
  let upstreamUrl
  try {
    upstreamUrl = upstreamRequestURL(settings, new URL(req.url ?? '/', 'http://qwen.invalid'))
  } catch (error) {
    sendJson(res, 500, { ok: false, error: { message: `Invalid upstream URL: ${userError(error)}` } })
    return
  }
  const transport = upstreamUrl.protocol === 'https:' ? https : http
  const headers = { ...req.headers, host: upstreamUrl.host, 'accept-encoding': 'identity' }
  for (const name of [...HOP_BY_HOP, 'content-length']) delete headers[name]
  const chunks = []
  let size = 0
  let rejected = false
  let upstreamReq = null
  req.on('data', (chunk) => {
    if (rejected) return
    size += chunk.length
    if (size > MAX_PROXY_BODY) {
      rejected = true
      chunks.length = 0
      sendJson(res, 413, { ok: false, error: { message: 'request body is too large' } })
      req.resume()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (rejected) return
    let body = Buffer.concat(chunks)
    let active = false
    let activeModel = ''
    let mtpActive = false
    if (settings.mode === 'auto' && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        if (ownsModel(parsed?.model)) {
          const model = parsed.model
          active = true
          activeModel = model
          const reasoning = modelReasoning(model)
          const vision = runtime.visionModels.has(model)
          const media = bodyHasMedia(parsed)
          const thinking = reasoning === false ? false : thinkingEnabled(parsed)
          const mtp = media && vision
            ? canMtp(model) && runtime.mtpApproved.has(model)
            : useMtp(model)
          mtpActive = mtp
          body = Buffer.from(JSON.stringify(applyRequestDefaults(parsed, settings, {
            thinking,
            reasoning,
            vision,
            context: modelLoadContext(model),
            mtp,
            mtpDraft: mtpDraftFor(model),
          })), 'utf8')
          consumeMtpChoice(model)
        }
      } catch {
        // Preserve non-JSON bodies unchanged.
      }
    }
    headers['content-length'] = String(body.length)
    try {
      upstreamReq = transport.request(upstreamUrl, { method: req.method, headers }, (upstreamRes) => {
        writeProxyResponse(upstreamRes, res, {
          active,
          onUsage: (usage) => recordMtpUsage(activeModel, usage, mtpActive),
        })
      })
    } catch (error) {
      logger.warn(`[${SCOPE}] cannot create upstream request: ${userError(error)}`)
      sendJson(res, 502, { ok: false, error: { message: userError(error) } })
      return
    }
    upstreamReq.setNoDelay(true)
    upstreamReq.on('error', (error) => {
      logger.warn(`[${SCOPE}] upstream request failed: ${userError(error)}`)
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: { message: userError(error) } })
      else res.destroy()
    })
    upstreamReq.end(body)
  })
  req.on('error', (error) => {
    upstreamReq?.destroy()
    logger.warn(`[${SCOPE}] proxy request failed: ${userError(error)}`)
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: { message: userError(error) } })
  })
  req.on('aborted', () => {
    rejected = true
    upstreamReq?.destroy()
  })
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq?.destroy()
  })
}

/** The reply-only preset text for one locale. */
function replyOnlyText(locale) {
  return locale.startsWith('en')
    ? { name: 'Reply Only', description: 'Tool calls are hidden and denied; replies stay plain text.' }
    : { name: '仅回复', description: '禁止工具调用，仅进行纯文本对话。' }
}

function replyOnlyPreset(presets, locale) {
  const current = presets[REPLY_ONLY_KEY]
  const text = replyOnlyText(locale)
  return {
    sandbox: current?.sandbox ?? 'read-only',
    approval: current?.approval ?? 'never',
    name: text.name,
    description: text.description,
  }
}

function samePreset(left, right) {
  return left?.sandbox === right.sandbox
    && left?.approval === right.approval
    && left?.name === right.name
    && left?.description === right.description
}

/** Read the merged permission config without editing it. */
function readPermissionConfig(ctx) {
  const entry = ctx.configEditor.entries().find((candidate) => {
    return candidate.options?.id === 'permission' || candidate.id?.endsWith(':permission')
  })
  if (entry === undefined) return { entry: null, config: {} }
  const row = ctx.configEditor.configuration().find((candidate) => candidate.entry === entry)
  return { entry, config: { ...(row?.inherited ?? {}), ...(row?.override ?? {}) } }
}

/**
 * Keep the reply-only preset present and localized, without rewriting the
 * profile patch when nothing changed.
 */
async function ensureReplyOnlyPreset(ctx, locale) {
  const { entry, config } = readPermissionConfig(ctx)
  const text = replyOnlyText(locale)
  if (entry === null) return { updated: false, ...text }
  const presets = config.presets !== null && typeof config.presets === 'object' ? config.presets : {}
  if (samePreset(presets[REPLY_ONLY_KEY], replyOnlyPreset(presets, locale))) return { updated: false, ...text }
  await ctx.configEditor.edit(entry, (current, inherited) => {
    const base = { ...(inherited ?? {}), ...(current ?? {}) }
    const merged = { ...((inherited ?? {}).presets ?? {}), ...((current ?? {}).presets ?? {}) }
    return { ...base, presets: { ...merged, [REPLY_ONLY_KEY]: replyOnlyPreset(merged, locale) } }
  })
  return { updated: true, ...text }
}

async function warmUpModel(ctx, settings, model, options) {
  const url = upstreamURL(settings, 'chat/completions')
  const body = {
    model,
    // GenieX treats a lone system message as a warm-up: the model loads with
    // these exact load parameters and no prefill or decoding runs.
    messages: [{ role: 'system', content: `You are ${shortModelName(model)}. Load the model; do not answer.` }],
    stream: false,
    enable_think: false,
    reasoning_format: 'auto',
    ...inferenceFields(settings, options.vision),
    ...loadFields(settings, options.context, options.mtp, options.mtpDraft),
  }
  const startedAt = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...await credentialHeader(ctx, settings) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  })
  const raw = await response.text()
  if (!response.ok) throw httpError(502, `model warmup failed: HTTP ${response.status}`)
  let usage
  try {
    usage = JSON.parse(raw)?.usage
  } catch {
    usage = undefined
  }
  return { elapsedMs: Date.now() - startedAt, usage }
}

/** Read the loaded-model state from GenieX's `/status`. */
async function readModelStatus(ctx) {
  const settings = runtime.settings
  if (!(settings.mode === 'auto' && settings.protocol === 'geniex' && settings.warm === true)) {
    return { active: false, models: [], warming: [], revision: runtime.modelRevision }
  }
  const cached = runtime.statusCache
  if (cached.key === settings.upstream && Date.now() - cached.at < 1500) {
    return { ...cached.value, warming: [...runtime.warmingModels], revision: runtime.modelRevision }
  }
  let value = { active: true, models: [], warming: [] }
  try {
    const url = new URL(settings.upstream)
    url.pathname = '/status'
    url.search = ''
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...await credentialHeader(ctx, settings) },
      signal: AbortSignal.timeout(2000),
    })
    if (response.ok) {
      const body = await response.json()
      const models = Array.isArray(body?.models) ? body.models.filter((model) => typeof model?.id === 'string') : []
      value = {
        active: true,
        models: models.map((model) => model.id),
        states: Object.fromEntries(models.map((model) => [model.id, model.state])),
      }
    }
  } catch {
    // A missing status endpoint means the client cannot classify warm models.
  }
  value.warming = [...runtime.warmingModels]
  value.revision = runtime.modelRevision
  runtime.statusCache = { key: settings.upstream, at: Date.now(), value }
  return value
}

/** The settings page state, cached until the next mutation. */
function readState(ctx) {
  if (runtime.stateCache !== null) return runtime.stateCache
  const settings = runtime.settings
  runtime.stateCache = {
    ...settings,
    lastError: runtime.bindError ?? settings.lastError,
    proxyBaseURL: proxyBaseURL(settings.proxyPort),
    ...readManagedProvider(ctx, settings),
  }
  return runtime.stateCache
}

/** Resolve capabilities for models the client is waiting on. */
async function ensureCapabilities(ctx) {
  if (runtime.managedModels.size === 0) return
  const missing = [...runtime.managedModels].filter((id) => {
    const capability = runtime.modelCapabilities.get(id)
    return capability === undefined || capability === null
  })
  if (missing.length === 0 || Date.now() < runtime.capabilityRetryAt) return
  runtime.capabilityRetryAt = Date.now() + 60000
  const entries = await mapLimit(missing, 4, async (id) => [id, await runtimeCapabilities(ctx).resolve(runtime.settings, id, true)])
  const merged = new Map()
  for (const id of runtime.managedModels) {
    const capability = runtime.modelCapabilities.get(id)
    if (capability !== undefined) merged.set(id, capability)
  }
  for (const [id, capability] of entries) merged.set(id, capability)
  if (applyCapabilities(merged)) runtime.modelRevision += 1
}

/** Build the API handler table. */
function createApi(ctx) {
  const api = {
    state: () => readState(ctx),
    modelStatus: () => readModelStatus(ctx),
    modelInfo: async () => {
      if (runtime.settings.protocol !== 'geniex') return { revision: runtime.modelRevision, models: {} }
      await ensureCapabilities(ctx)
      return {
        revision: runtime.modelRevision,
        models: Object.fromEntries([...runtime.managedModels].map((id) => {
          const capability = runtime.modelCapabilities.get(id)
          return [id, {
            abliterated: capability?.abliterated === true,
            hasMtp: capability?.hasMtp === true,
            mtpReady: capability?.mtpReady === true && runtime.mtpDrafts.has(id),
            mtpEnabled: runtime.settings.mtp === true,
            vision: runtime.visionModels.has(id),
            contextLength: positiveIntOrNull(capability?.contextLength),
            sampling: capability?.sampling ?? {},
            tags: capability?.tags ?? [],
            mtpStats: runtime.mtpStats.get(id) ?? null,
          }]
        })),
      }
    },
    mtpChoice: (payload) => {
      if (runtime.settings.protocol !== 'geniex') throw httpError(409, 'MTP is GenieX-only')
      const model = text(payload?.model)
      if (!runtime.mtpModels.has(model) || !runtime.mtpDrafts.has(model)) throw httpError(400, 'model has no MTP draft')
      if (payload?.allow === true) {
        runtime.mtpApproved.add(model)
        runtime.mtpSuppressed.delete(model)
      } else {
        runtime.mtpApproved.delete(model)
        runtime.mtpSuppressed.add(model)
      }
      return { ok: true }
    },
    setMode: async (payload) => {
      const mode = SUPPORTED_MODES.includes(payload?.mode) ? payload.mode : null
      if (mode === null) throw httpError(400, 'invalid mode')
      if (mode === runtime.settings.mode) return readState(ctx)
      const previous = runtime.settings.mode
      runtime.settings.mode = mode
      runtime.statusCache.at = 0
      invalidateState()
      try {
        await syncProvider(ctx)
        runtime.settings.lastError = null
      } catch (error) {
        runtime.settings.mode = previous
        runtime.settings.lastError = userError(error)
        invalidateState()
        await persistSettings()
        throw httpError(500, userError(error))
      }
      await persistSettings()
      return readState(ctx)
    },
    turnStats: async (payload) => {
      const sessionId = text(payload?.sessionId)
      const turn = Number(payload?.turn)
      if (sessionId === '' || !Number.isInteger(turn)) return null
      const key = `${sessionId}:${turn}`
      const cached = runtime.turnMetrics.get(key)
      if (cached !== undefined) return cached
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) return null
      await deriveSessionMetrics(session)
      return runtime.turnMetrics.get(key) ?? null
    },
    sessionProvider: (payload) => {
      const sessionId = text(payload?.sessionId)
      if (sessionId === '') return { geniex: false, pending: false }
      if (runtime.sessionProviders.has(sessionId)) return { geniex: true, pending: false }
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) return { geniex: false, pending: true }
      if (!runtime.derivedSessions.has(sessionId)) {
        void deriveSessionMetrics(session).catch(() => {})
        return { geniex: runtime.sessionProviders.has(sessionId), pending: true }
      }
      return { geniex: runtime.sessionProviders.has(sessionId), pending: false }
    },
    clientError: async (payload) => {
      const message = text(payload?.message).slice(0, 4096)
      const stack = text(payload?.stack).slice(0, 16384)
      if (message === '' && stack === '') return { recorded: false }
      const path = join(runtime.profileDir, CLIENT_ERROR_LOG)
      try {
        let size = 0
        try {
          size = (await stat(path)).size
        } catch {
          size = 0
        }
        if (size > CLIENT_ERROR_LOG_LIMIT) await writeFile(path, '', 'utf8')
        await appendFile(path, `${new Date().toISOString()} ${message}\n${stack}\n`, 'utf8')
      } catch {
        // Diagnostics must never break the settings page.
      }
      return { recorded: true }
    },
    permissionLabel: async (payload) => ensureReplyOnlyPreset(ctx, text(payload?.locale).toLowerCase()),
    warm: (payload) => {
      const generation = ++runtime.warmGeneration
      const operation = async () => {
        if (generation !== runtime.warmGeneration) return { warmed: false, skipped: true }
        const settings = runtime.settings
        if (settings.protocol !== 'geniex') throw httpError(409, 'model warmup is GenieX-only')
        if (settings.mode !== 'auto' || !settings.warm) throw httpError(409, 'model warmup is disabled')
        const model = text(payload?.model)
        if (model === '' || !runtime.managedModels.has(model)) throw httpError(400, 'unknown managed model')
        if (runtime.warmingModels.has(model)) return { warmed: false, model, skipped: true }
        if (!runtime.modelCapabilities.has(model)) {
          await refreshManagedModels(ctx, true)
          if (!runtime.managedModels.has(model)) throw httpError(400, 'unknown managed model')
        }
        runtime.warmingModels.add(model)
        runtime.statusCache.at = 0
        try {
          const result = await warmUpModel(ctx, settings, model, {
            vision: runtime.visionModels.has(model),
            context: modelLoadContext(model),
            mtp: useMtp(model),
            mtpDraft: mtpDraftFor(model),
          })
          return { warmed: true, model, ...result }
        } finally {
          runtime.warmingModels.delete(model)
          runtime.statusCache.at = 0
        }
      }
      const result = runtime.warmQueue.then(operation, operation)
      runtime.warmQueue = result.then(() => undefined, () => undefined)
      return result
    },
    save: async (payload) => {
      const mode = [...SUPPORTED_MODES, 'always'].includes(payload?.mode) ? payload.mode : runtime.settings.mode
      if (typeof payload?.upstream === 'string') assertUpstream(payload.upstream)
      if (typeof payload?.apiKeyEnv === 'string') assertApiKeyRef(payload.apiKeyEnv)
      const previous = runtime.settings
      const next = normalizeSettings({
        ...previous,
        ...payload,
        mode,
        proxyPort: previous.proxyPort,
      })
      const providerChanged = ['protocol', 'upstream', 'apiKeyEnv', 'contextWindow', 'maxOutputTokens', 'autoNctx']
        .some((key) => next[key] !== previous[key])
      const providerRemoval = next.mode === 'off' && next.managedProviderId !== null
      const requiresSync = next.mode !== previous.mode
        || providerChanged
        || providerRemoval
        || (next.mode === 'auto' && next.managedProviderId === null)
      const loadChanged = requiresSync
        || next.contextWindow !== previous.contextWindow
        || next.autoNctx !== previous.autoNctx
        || next.maxOutputTokens !== previous.maxOutputTokens
        || next.mtp !== previous.mtp
        || next.mtpDraftTokens !== previous.mtpDraftTokens
        || next.mtpDraftMin !== previous.mtpDraftMin
        || next.mtpDraftPMin !== previous.mtpDraftPMin
        || next.compute !== previous.compute
        || next.vitCompute !== previous.vitCompute
      const revisionBefore = runtime.modelRevision
      runtime.settings = next
      invalidateState()
      runtime.statusCache.at = 0
      try {
        if (requiresSync) await syncProvider(ctx)
        runtime.settings.lastError = null
      } catch (error) {
        runtime.settings.lastError = userError(error)
      }
      if (loadChanged && runtime.modelRevision === revisionBefore) runtime.modelRevision += 1
      await persistSettings()
      return readState(ctx)
    },
    apply: async () => {
      try {
        runtimeCapabilities(ctx).invalidate(runtime.settings.upstream)
        runtime.capabilityRetryAt = 0
        await syncProvider(ctx)
        runtime.settings.lastError = null
      } catch (error) {
        runtime.settings.lastError = userError(error)
      }
      await persistSettings()
      return readState(ctx)
    },
    remove: async () => {
      invalidateState()
      try {
        await providerTask(async () => {
          await deleteProvider(ctx, runtime.settings.managedProviderId)
          runtime.settings.managedProviderId = null
        })
        runtime.qairtDrafts = new Map()
        runtime.qairtDraftsKey = ''
        applyManagedProvider(null)
        if (applyCapabilities(new Map())) runtime.modelRevision += 1
        runtime.settings.lastError = null
      } catch (error) {
        runtime.settings.lastError = userError(error)
      }
      await persistSettings()
      return readState(ctx)
    },
  }
  return api
}

/** Serialize settings writes. */
function persistSettings() {
  const run = async () => {
    const settings = runtime.settings
    await mkdir(runtime.profileDir, { recursive: true })
    const payload = { ...settings }
    delete payload.lastError
    const body = `${JSON.stringify(payload, null, 2)}\n`
    const temporary = `${runtime.storePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, body, 'utf8')
    try {
      await rename(temporary, runtime.storePath)
    } catch {
      await writeFile(runtime.storePath, body, 'utf8')
      try {
        await unlink(temporary)
      } catch {
        // A leftover temporary file is harmless.
      }
    }
  }
  const next = persistChain.then(run, run)
  persistChain = next.then(() => undefined, () => undefined)
  return next
}

/** Bind the loopback proxy, sliding to the next port when one is taken. */
async function startProxy() {
  const server = http.createServer((req, res) => handleProxyRequest(req, res))
  const preferred = runtime.settings.proxyPort
  let bound = null
  for (let offset = 0; offset <= PROXY_PORT_ATTEMPTS; offset += 1) {
    const port = preferred + offset
    if (port <= 0 || port > 65535) break
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
      bound = port
      break
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') {
        runtime.logger.warn(`[${SCOPE}] cannot bind proxy on ${port}: ${userError(error)}`)
        break
      }
    }
  }
  if (bound === null) {
    runtime.bindError = `Cannot bind the Qwen mode proxy near port ${preferred}`
    invalidateState()
    return null
  }
  runtime.bindError = null
  if (runtime.settings.proxyPort !== bound) {
    runtime.settings.proxyPort = bound
    invalidateState()
    await persistSettings().catch(() => {})
  }
  return server
}

/** Keep the settings page and tool guard wired to the reply-only preset. */
function applyReplyOnly(ctx, agent) {
  const session = ctx.sessions.get(agent.id)
  if (session === undefined) return
  let reply = false
  try {
    reply = ctx.permissionPresets.current(session) === REPLY_ONLY_KEY
  } catch {
    return
  }
  const active = runtime.replyRestrictions.get(agent.id)
  if (!reply) {
    if (active !== undefined) {
      active()
      runtime.replyRestrictions.delete(agent.id)
    }
    return
  }
  if (active !== undefined) return
  try {
    const scoped = agent.ctx
    if (scoped?.tools?.restrict !== undefined) {
      runtime.replyRestrictions.set(agent.id, scoped.tools.restrict({ allow: [] }))
    }
  } catch (error) {
    runtime.logger.warn(`[${SCOPE}] cannot hide tools for reply-only session: ${userError(error)}`)
  }
}

function registerWebApi(ctx, api) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (ctx.connection.requestRejection(req) !== undefined) {
        sendJson(res, 403, { ok: false, error: { message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { message: 'POST only' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://qwen.invalid').pathname
      const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : ''
      try {
        if (method === '' || !Object.hasOwn(api, method)) throw httpError(404, 'unknown method')
        const payload = await readJson(req, MAX_API_BODY)
        sendJson(res, 200, { ok: true, value: await api[method](payload) })
      } catch (error) {
        sendJson(res, error?.status ?? 500, { ok: false, error: { message: userError(error) } })
      }
    },
  })
}

/** Serialize mutating API calls so settings writes cannot interleave. */
function serializeMutations(api) {
  let queue = Promise.resolve()
  for (const method of ['setMode', 'save', 'apply', 'remove', 'permissionLabel']) {
    const operation = api[method]
    api[method] = (payload) => {
      const run = queue.then(() => operation(payload), () => operation(payload))
      queue = run.then(() => undefined, () => undefined)
      return run
    }
  }
}

export async function apply(ctx) {
  runtime = createRuntime()
  const instance = runtime
  providerChain = Promise.resolve()
  persistChain = Promise.resolve()
  runtime.logger = loggerFor(ctx, SCOPE)
  runtime.profileDir = text(process.env.DSH_PROFILE_DIR) || process.cwd()
  runtime.storePath = join(runtime.profileDir, STORE_FILE)

  let loaded = normalizeSettings({})
  try {
    loaded = normalizeSettings(JSON.parse(await readFile(runtime.storePath, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') runtime.logger.warn(`[${SCOPE}] cannot read settings: ${userError(error)}`)
  }
  runtime.settings = loaded
  runtime.settings.lastError = null
  await persistSettings().catch((error) => runtime.logger.warn(`[${SCOPE}] cannot save settings: ${userError(error)}`))

  applyManagedProvider(readManagedProvider(ctx, runtime.settings).provider)
  const api = createApi(ctx)
  serializeMutations(api)

  ctx.effect(() => registerWebApi(ctx, api), `${SCOPE}: settings API`)

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const turn = event.data?.turn
    const step = event.data?.step
    if (!Number.isInteger(turn) || !Number.isInteger(step)) return
    const key = `${session.id}:${turn}:${step}`
    if (event.type === 'step/start') {
      runtime.stepStarts.set(key, event.time)
      trimMap(runtime.stepStarts, 2000)
      return
    }
    if (event.type === 'assistant/attempt') {
      const first = streamFirstTokenTime(event.data.stream)
      if (first !== undefined) runtime.firstTokens.set(key, first)
      trimMap(runtime.firstTokens, 2000)
      return
    }
    if (event.type !== 'assistant/message') return
    const first = runtime.firstTokens.get(key) ?? streamFirstTokenTime(event.data.stream) ?? event.time
    const start = runtime.stepStarts.get(key) ?? first
    runtime.stepStarts.delete(key)
    runtime.firstTokens.delete(key)
    const metric = buildTurnMetric(event, first, start)
    if (metric === null) return
    recordTurn(session.id, turn, metric)
  }), `${SCOPE}: turn metrics`)

  ctx.effect(() => ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    const session = ctx.sessions.get(agent.id)
    if (session === undefined) return undefined
    try {
      return ctx.permissionPresets.current(session) === REPLY_ONLY_KEY
        ? 'Reply-only mode: tool calls are disabled'
        : undefined
    } catch {
      return undefined
    }
  }), `${SCOPE}: reply-only tool guard`)

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => applyReplyOnly(ctx, agent)), `${SCOPE}: reply-only agent setup`)
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type !== 'permission/preset' && event.type !== 'sandbox/mode' && event.type !== 'approval/policy') return
    queueMicrotask(() => {
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) applyReplyOnly(ctx, agent)
    })
  }), `${SCOPE}: reply-only permission changes`)
  ctx.effect(() => () => {
    for (const dispose of instance.replyRestrictions.values()) dispose()
    instance.replyRestrictions.clear()
  }, `${SCOPE}: reply-only restrictions`)
  for (const agent of ctx.agents.list()) applyReplyOnly(ctx, agent)

  const server = await startProxy()
  if (server !== null) {
    ctx.effect(() => () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    }), `${SCOPE}: proxy server`)
  }

  // Provider discovery talks to the upstream, so it must never delay activation:
  // a stopped GenieX would otherwise stall the plugin (and its settings page)
  // for the full discovery timeout.
  const startupSync = async (attempt = 0) => {
    if (runtime !== instance) return
    try {
      await refreshManagedModels(ctx, true)
      await syncProvider(ctx)
      if (runtime !== instance) return
      runtime.settings.lastError = null
      invalidateState()
      await persistSettings()
    } catch (error) {
      if (runtime !== instance) return
      runtime.settings.lastError = userError(error)
      invalidateState()
      runtime.logger.warn(`[${SCOPE}] cannot refresh managed provider: ${userError(error)}`)
      if (attempt < 2 && userError(error).includes('llm-pi-ai entry not found')) {
        instance.startupTimer = setTimeout(() => { void startupSync(attempt + 1) }, 2000)
      }
    }
  }
  void startupSync()

  ctx.effect(() => () => {
    if (instance.startupTimer !== null) clearTimeout(instance.startupTimer)
  }, `${SCOPE}: startup timer`)
}
