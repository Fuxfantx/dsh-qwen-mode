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
import { isDeepStrictEqual } from 'node:util'
import { createCapabilityResolver, supportsPreserveThinking } from './lib/capabilities.js'
import { createThinkState, rewriteMessage, transformSseEvent } from './lib/reasoning.js'
import {
  clampedNumber,
  delay,
  httpError,
  isCredentialRef,
  loggerFor,
  mapLimit,
  numberOrNull,
  positiveInt,
  positiveIntOrNull,
  readJson,
  runConfigEdit,
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
const MAX_EVENT_BUFFER = 4 * 1024 * 1024
const MAX_JSON_RESPONSE = 32 * 1024 * 1024
const DEFAULT_PROXY_PORT = 18182
const PROXY_PORT_TRIES = 8
const DEFAULT_QWEN_CONTEXT = 262144
const DEFAULT_GENIEX_CONTEXT = 131072
// A QAIRT context window is compiled into the bundle and cannot be changed by
// `nctx`; assuming the much larger llama.cpp default would over-claim it.
const DEFAULT_QAIRT_CONTEXT = 32768
// The output cap is a per-request reservation shared with the prompt, so a
// local model needs a prompt budget far larger than its answer budget.
const DEFAULT_MAX_OUTPUT = 16384
const DISCOVERY_TIMEOUT_MS = 15000
const DISCOVERY_ATTEMPTS = 2
const WARMUP_TIMEOUT_MS = 10 * 60 * 1000
const SYNC_RETRY_DELAYS = [1000, 3000, 8000, 15000]
const MTP_SPEC_TYPE = 'draft-mtp'
const MTP_DRAFT_TOKENS = 3
const PROVIDERS = {
  geniex: { id: 'from-geniex', name: 'From GenieX' },
  qwen: { id: 'from-qwencloud', name: 'From QwenCloud' },
}
const QWEN_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])
const MEDIA_PART_TYPES = new Set(['image_url', 'input_image', 'image', 'input_audio', 'audio', 'video', 'video_url'])
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
const SUPPORTED_MODES = ['off', 'auto']
const VIT_COMPUTE_VALUES = new Set(['', 'cpu', 'gpu', 'npu'])
const REPLY_ONLY_KEY = 'reply-only'
/** Settings the settings page may write; everything else is host-owned. */
const SAVE_FIELDS = [
  'mode',
  'protocol',
  'upstream',
  'apiKeyEnv',
  'warm',
  'contextWindow',
  'maxOutputTokens',
  'autoNctx',
  'mtp',
  'mtpDraftTokens',
  'mtpDraftMin',
  'mtpDraftPMin',
  'compute',
  'vitCompute',
  'temperature',
  'topP',
  'topK',
  'minP',
  'repetitionPenalty',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
]

const DEFAULTS = {
  upstream: 'http://127.0.0.1:18181',
  maxOutputTokens: DEFAULT_MAX_OUTPUT,
  mtpDraftTokens: MTP_DRAFT_TOKENS,
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
  const mtpDraftTokens = integerOrNull(source.mtpDraftTokens, 1, 64) ?? DEFAULTS.mtpDraftTokens
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
    mtpDraftTokens,
    // A speculative minimum above the maximum makes GenieX reject the load.
    mtpDraftMin: Math.min(integerOrNull(source.mtpDraftMin, 0, 64) ?? 0, mtpDraftTokens),
    mtpDraftPMin: clampedNumber(source.mtpDraftPMin, 0, 1) ?? 0,
    compute: text(source.compute).slice(0, 100),
    vitCompute: VIT_COMPUTE_VALUES.has(source.vitCompute) ? source.vitCompute : '',
    temperature: clampedNumber(source.temperature, 0, 2),
    topP: clampedNumber(source.topP, 0, 1),
    topK: integerOrNull(source.topK, 0, 1000),
    minP: clampedNumber(source.minP, 0, 1),
    repetitionPenalty: clampedNumber(source.repetitionPenalty, 0, 5),
    presencePenalty: clampedNumber(source.presencePenalty, -2, 2),
    frequencyPenalty: clampedNumber(source.frequencyPenalty, -2, 2),
    // GenieX casts the seed to int32; keep one range valid for both sources.
    seed: integerOrNull(source.seed, 0, 2147483647),
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
  // Only QwenCloud authenticates. A key reference remembered from a previous
  // QwenCloud selection must not follow the user back to GenieX.
  return settings.protocol === 'qwen' ? text(settings.apiKeyEnv) || 'local' : 'local'
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
 * GenieX loads llama.cpp models with `nctx` explicitly, so the value advertised
 * to DSH must be the same number: over-claiming makes DSH skip compaction until
 * the upstream rejects the prompt, under-claiming compacts far too early.
 */
function effectiveContext(settings, metadataContext, runtime = '') {
  const metadata = positiveIntOrNull(metadataContext)
  // "Prefer model context limit" overrides an explicit value; otherwise an
  // explicit setting is the user's override and wins over the model metadata.
  if (metadata !== null && settings.autoNctx) return metadata
  if (settings.contextWindow !== null) return settings.contextWindow
  if (metadata !== null) return metadata
  if (settings.protocol === 'qwen') return DEFAULT_QWEN_CONTEXT
  return runtime === 'qairt' ? DEFAULT_QAIRT_CONTEXT : DEFAULT_GENIEX_CONTEXT
}

function requestedEffort(body) {
  return typeof body?.reasoning_effort === 'string' ? body.reasoning_effort.trim().toLowerCase() : ''
}

/**
 * Whether one request body asks the model to think.
 * @returns true or false when the request says so, undefined when the upstream
 *   default should decide (DSH sends no thinking field for unknown models).
 */
function requestedThinking(body) {
  const effort = requestedEffort(body)
  if (effort !== '') return !['off', 'none'].includes(effort)
  if (typeof body.enable_think === 'boolean') return body.enable_think
  if (typeof body.enable_thinking === 'boolean') return body.enable_thinking
  return undefined
}

function inferenceFields(settings, vision) {
  const fields = {}
  if (settings.compute !== '') fields.compute = settings.compute
  // Only image requests select the vision encoder; text requests keep the
  // GenieX default for that backend.
  if (vision && settings.vitCompute !== '') fields.vit_compute = settings.vitCompute
  return fields
}

/**
 * GenieX model-load fields.
 *
 * GenieX keeps a single loaded model and keys its cache on exactly these
 * values, so the warm-up and the following request must be produced by this
 * one function; any difference destroys the warmed model on the first send.
 */
function loadFields(settings, options) {
  const fields = {}
  if (settings.protocol !== 'geniex') return fields
  if (typeof options.context === 'number' && options.context > 0) fields.nctx = options.context
  if (options.mtp === true && options.mtpDraft !== '') {
    fields.spec_type = MTP_SPEC_TYPE
    fields.spec_draft_model = options.mtpDraft
    // Speculative decoding is llama.cpp-only in GenieX; every other runtime
    // ignores `spec_*`, so there is no second shape to produce here.
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
      if (options.thinking === undefined) delete output.enable_thinking
      else output.enable_thinking = options.thinking
      if (options.thinking === true && options.preserveThinking === true) output.preserve_thinking = true
      else delete output.preserve_thinking
      const effort = requestedEffort(body)
      // Model Studio accepts only its documented levels; the family table's
      // `enabled` spelling for on/off is not one of them and would 400.
      if (options.thinking !== false && QWEN_REASONING_EFFORTS.has(effort)) output.reasoning_effort = effort
      else delete output.reasoning_effort
    }
  } else {
    // GenieX has no reasoning_effort field; thinking is expressed only through
    // `enable_think`, and an absent value keeps the server default.
    if (options.thinking === undefined) delete output.enable_think
    else output.enable_think = options.thinking
    delete output.enable_thinking
    delete output.preserve_thinking
    delete output.reasoning_effort
    output.reasoning_format = 'auto'
    Object.assign(output, inferenceFields(settings, options.vision))
    Object.assign(output, loadFields(settings, options))
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
  fill('seed', settings.seed)
  if (output.stream === true) {
    const current = output.stream_options
    output.stream_options = {
      ...(current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}),
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
  const records = Array.isArray(stream)
    ? stream
    : stream instanceof Map
      ? [...stream.values()]
      : stream !== null && typeof stream === 'object'
        ? Object.values(stream)
        : null
  if (records === null) return undefined
  for (const record of records) {
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
function buildTurnMetric(event, firstTokenAt, startedAt, step) {
  const source = event.data?.message?.source
  if (typeof source?.provider !== 'string' || typeof source?.model !== 'string') return null
  const outputTokens = event.data?.usage?.outputTokens ?? null
  const ttftMs = Math.max(0, Math.round(firstTokenAt - startedAt))
  const decodeMs = Math.max(1, event.time - firstTokenAt)
  const content = event.data?.message?.content
  const toolCall = Array.isArray(content) && content.some((block) => block?.type === 'tool-call')
  return {
    id: `${step ?? ''}:${event.time}`,
    time: event.time,
    firstTokenAt,
    provider: source.provider,
    model: source.model,
    ttftMs,
    netTtftMs: ttftMs,
    decodeMs,
    tps: outputTokens === null ? null : Math.round(outputTokens / (decodeMs / 1000) * 10) / 10,
    outputTokens,
    toolCall,
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
  if (runtime.disposed) return
  const { entry } = readProviderConfig(ctx)
  await runConfigEdit(ctx, entry, (current, inherited) => {
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

/** The output cap one provider model exposes to DSH. */
function modelTokenLimit(settings, capability, contextWindow) {
  const declared = positiveIntOrNull(capability?.maxOutput)
  return Math.max(1, Math.min(settings.maxOutputTokens, declared ?? contextWindow, contextWindow))
}

/** Build one provider model entry from resolved capabilities. */
function buildModelSpec(settings, id, capability) {
  const runtimeId = typeof capability?.runtime === 'string' ? capability.runtime : ''
  const contextWindow = effectiveContext(settings, positiveIntOrNull(capability?.contextLength), runtimeId)
  const model = {
    id,
    name: shortModelName(id),
    maxTokens: modelTokenLimit(settings, capability, contextWindow),
    contextWindow,
    input: capability?.vision === true ? ['text', 'image'] : ['text'],
  }
  if (capability?.reasoningEfforts !== undefined) model.reasoningEfforts = capability.reasoningEfforts
  return model
}

/**
 * Fetch JSON with a bounded, retried request. Model discovery on GenieX waits
 * behind the server's request GIL while a model is generating, so a transient
 * timeout is expected even on a healthy local server.
 */
async function fetchJson(url, { headers, timeout, attempts = 1 }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
      if (!response.ok) {
        const error = httpError(502, `model discovery failed: HTTP ${response.status}`)
        error.retryable = response.status >= 500 || response.status === 429
        throw error
      }
      return await response.json()
    } catch (error) {
      if (attempt >= attempts - 1 || error?.retryable === false) throw error
      await delay(500 * (attempt + 1))
    }
  }
}

/**
 * Discover the upstream catalog and resolve every model's capabilities.
 *
 * Locally cached assistant models are ordinary catalogue entries: GenieX only
 * uses speculative decoding on llama.cpp, where the draft is a file inside the
 * target model's own directory.
 */
async function discoverModels(ctx, settings, capabilities) {
  if (settings.protocol === 'qwen') {
    // Model Studio's compatible base URL has no /models endpoint; its catalog
    // lives under /api/v1/models and also reports context and modalities.
    const listed = await capabilities.listQwenModels(settings)
    if (listed.size > 0) {
      const models = [...listed].map(([id, capability]) => buildModelSpec(settings, id, capability))
      return { models, capabilities: listed }
    }
  }
  const url = upstreamURL(settings, 'models')
  const headers = { accept: 'application/json', ...await credentialHeader(ctx, settings) }
  const body = await fetchJson(url, { headers, timeout: DISCOVERY_TIMEOUT_MS, attempts: DISCOVERY_ATTEMPTS })
  const rows = Array.isArray(body?.data) ? body.data : []
  const ids = [...new Set(rows.map((row) => (typeof row?.id === 'string' ? row.id.trim() : '')).filter((id) => id !== ''))]
  if (ids.length === 0) throw httpError(502, 'model discovery returned no models')
  const resolved = new Map()
  await mapLimit(ids, 4, async (id) => {
    resolved.set(id, await capabilities.resolve(settings, id))
  })
  return {
    models: ids.map((id) => buildModelSpec(settings, id, resolved.get(id))),
    capabilities: resolved,
  }
}

/** The settings that make one provider build obsolete when they change. */
function providerSettingsKey(settings = runtime.settings) {
  return [settings.mode, settings.protocol, settings.upstream, apiKeyRef(settings), settings.contextWindow, settings.maxOutputTokens, settings.autoNctx].join('|')
}

/** Whether the settings that produced one provider snapshot are still current. */
function providerSettingsCurrent(snapshot) {
  return !runtime.disposed && providerSettingsKey(runtime.settings) === providerSettingsKey(snapshot)
}

async function upsertProvider(ctx, settings) {
  const keyRef = apiKeyRef(settings)
  if (keyRef === 'local') await ensureLocalCredential(ctx)
  const { models, capabilities } = await discoverModels(ctx, settings, runtimeCapabilities(ctx))
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
  // Commit only if the settings that asked for this provider are still current.
  // A mode switch to Off runs its delete immediately, and this guard keeps a
  // slow in-flight discovery from resurrecting the provider afterwards. When
  // the committed entry already equals the discovered one, skip the write:
  // a redundant edit rewrites the profile patch and wakes HMR for nothing.
  let changed = true
  const otherIds = Object.values(PROVIDERS).map((provider) => provider.id).filter((providerId) => providerId !== id)
  try {
    const { providers } = readProviderConfig(ctx)
    changed = settings.managedProviderId !== id
      || !isDeepStrictEqual(providers[id], desired)
      || otherIds.some((providerId) => providers[providerId] !== undefined)
  } catch {
    // The provider table is unreadable; let the edit surface the failure.
  }
  if (changed) {
    let committed = false
    await editProviders(ctx, (providers) => {
      if (!providerSettingsCurrent(settings)) {
        // Never let a stale discovery resurrect a provider after the user
        // turned the mode off or changed the source.
        for (const providerId of [id, ...otherIds]) delete providers[providerId]
        return
      }
      const previous = settings.managedProviderId
      if (previous !== null && previous !== id) delete providers[previous]
      for (const otherId of otherIds) delete providers[otherId]
      providers[id] = desired
      committed = true
    })
    if (!committed || !providerSettingsCurrent(settings)) {
      await deleteProviders(ctx, [id, ...otherIds, settings.managedProviderId])
      return null
    }
  } else if (!providerSettingsCurrent(settings)) {
    return null
  }
  runtime.settings.managedProviderId = id
  runtime.settings.lastError = null
  if (changed) {
    try {
      ctx.emit('llm/models-updated', id)
      ctx.emit('llm/adapters-updated')
    } catch {
      // Catalog refresh is best-effort; the provider config is already committed.
    }
  }
  return {
    id,
    displayName: desired.displayName,
    baseURL: desired.baseURL,
    models: models.map((model) => model.id),
    visionModels: models.filter((model) => model.input.includes('image')).map((model) => model.id),
    capabilities,
    entries: models,
  }
}

/** Provider ids this plugin owns, including entries left by an older install. */
function managedProviderIds(settings) {
  return [settings.managedProviderId, PROVIDERS.geniex.id, PROVIDERS.qwen.id]
}

/** Delete the managed providers that are actually present in the config. */
async function deleteProviders(ctx, ids) {
  if (runtime.disposed) return
  let present
  try {
    const { providers } = readProviderConfig(ctx)
    present = [...new Set(ids)].filter((id) => typeof id === 'string' && id !== '' && providers[id] !== undefined)
  } catch {
    return
  }
  if (present.length === 0) return
  await editProviders(ctx, (providers) => {
    for (const id of present) delete providers[id]
  })
  try {
    for (const id of present) ctx.emit('llm/models-updated', id)
    ctx.emit('llm/adapters-updated')
  } catch {
    // Catalog refresh is best-effort.
  }
}

function readManagedProvider(ctx, settings) {
  try {
    const { providers } = readProviderConfig(ctx)
    const id = settings.managedProviderId
    const provider = id === null ? undefined : providers[id]
    const entries = Array.isArray(provider?.models) ? provider.models : []
    const models = []
    const visionModels = []
    for (const model of entries) {
      if (typeof model?.id !== 'string') continue
      models.push(model.id)
      if (Array.isArray(model.input) && model.input.includes('image')) visionModels.push(model.id)
    }
    return {
      provider: id === null ? null : {
        id,
        displayName: provider?.displayName ?? providerNameFor(settings.protocol),
        baseURL: provider?.baseURL ?? '',
        exists: provider !== undefined,
        models,
        visionModels,
        entries,
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
    disposed: false,
    profileDir: '',
    storePath: '',
    logger: null,
    capabilities: null,
    managedModels: new Set(),
    visionModels: new Set(),
    modelMaxTokens: new Map(),
    mtpDrafts: new Map(),
    modelContexts: new Map(),
    modelCapabilities: new Map(),
    modelReasoning: new Map(),
    capabilitySignature: '',
    loadSignatures: new Map(),
    loadRevisions: new Map(),
    loadRevision: 0,
    modelRevision: 0,
    capabilityRetryAt: 0,
    pendingSync: 0,
    syncGeneration: 0,
    stateCache: null,
    statusCache: { key: '', at: 0, value: null },
    turnMetrics: new Map(),
    requestStarts: new Map(),
    currentSteps: new Map(),
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
    providerChain: Promise.resolve(),
    persistChain: Promise.resolve(),
    bindError: null,
    replyRestrictions: new Map(),
  }
}

let runtime = createRuntime()

function invalidateState() {
  runtime.stateCache = null
}

function invalidateStatus() {
  runtime.statusCache = { key: '', at: 0, value: null }
}

/** Advance the warm revision for the models whose load inputs changed. */
function bumpLoadRevision(ids) {
  runtime.loadRevision += 1
  for (const id of ids) runtime.loadRevisions.set(id, runtime.loadRevision)
}

/** Apply one provider snapshot to the managed model sets. */
function applyManagedProvider(provider) {
  runtime.managedModels.clear()
  runtime.visionModels.clear()
  runtime.modelMaxTokens.clear()
  runtime.modelContexts.clear()
  runtime.modelReasoning.clear()
  for (const id of provider?.models ?? []) runtime.managedModels.add(id)
  for (const id of provider?.visionModels ?? []) runtime.visionModels.add(id)
  // The provider entry already records each model's context, output cap, and
  // thinking capability, so the first request after a restart does not fall
  // back to the plugin default while the local metadata is being re-read.
  for (const model of provider?.entries ?? []) {
    if (typeof model?.id !== 'string') continue
    if (model.reasoningEfforts === false) runtime.modelReasoning.set(model.id, false)
    else if (model.reasoningEfforts !== undefined) runtime.modelReasoning.set(model.id, true)
    const context = positiveIntOrNull(model.contextWindow)
    if (context !== null) runtime.modelContexts.set(model.id, context)
    const maxTokens = positiveIntOrNull(model.maxTokens)
    if (maxTokens !== null) runtime.modelMaxTokens.set(model.id, maxTokens)
  }
}

/** Drop every managed model and warm revision. */
function clearManagedState() {
  applyManagedProvider(null)
  if (applyCapabilities(new Map())) runtime.modelRevision += 1
  invalidateState()
}

/** Rebuild the capability-derived sets; returns whether anything changed. */
function applyCapabilities(capabilities) {
  const sorted = [...capabilities].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const signature = JSON.stringify(sorted.map(([id, capability]) => [
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
  // Warm state must follow only what GenieX loads, not sampling/tags. Keep it
  // per model so a catalog change for another model cannot re-warm this one.
  const warmSignature = (capability) => JSON.stringify([
    capability?.contextLength ?? null,
    capability?.vision ?? null,
    capability?.runtime ?? null,
    capability?.mtpDraft ?? null,
    capability?.mtpReady ?? null,
  ])
  runtime.mtpDrafts.clear()
  runtime.modelContexts.clear()
  runtime.modelCapabilities.clear()
  for (const [id, capability] of capabilities) {
    runtime.modelCapabilities.set(id, capability)
    if (capability?.mtpReady === true && typeof capability?.mtpDraft === 'string' && capability.mtpDraft !== '') {
      runtime.mtpDrafts.set(id, capability.mtpDraft)
    }
    if (positiveIntOrNull(capability?.contextLength) !== null) runtime.modelContexts.set(id, capability.contextLength)
    if (capability === null || capability === undefined) {
      runtime.loadSignatures.delete(id)
      runtime.loadRevisions.delete(id)
      continue
    }
    const rowSignature = warmSignature(capability)
    if (runtime.loadSignatures.get(id) !== rowSignature) {
      runtime.loadSignatures.set(id, rowSignature)
      bumpLoadRevision([id])
    }
  }
  for (const id of [...runtime.loadSignatures.keys()]) {
    if (!capabilities.has(id)) {
      runtime.loadSignatures.delete(id)
      runtime.loadRevisions.delete(id)
    }
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
async function refreshManagedModels(ctx) {
  const instance = runtime
  const snapshot = { ...instance.settings }
  const key = [snapshot.mode, snapshot.protocol, snapshot.upstream, snapshot.managedProviderId].join('|')
  const currentKey = () => [instance.settings.mode, instance.settings.protocol, instance.settings.upstream, instance.settings.managedProviderId].join('|')
  if (snapshot.mode !== 'auto') {
    if (runtime !== instance || instance.disposed || currentKey() !== key) return
    clearManagedState()
    return
  }
  const provider = readManagedProvider(ctx, snapshot).provider
  const capabilities = new Map()
  if (snapshot.protocol === 'geniex') {
    const ids = provider?.models ?? []
    await mapLimit(ids, 4, async (id) => {
      capabilities.set(id, await runtimeCapabilities(ctx).resolve(snapshot, id))
    })
  }
  if (runtime !== instance || instance.disposed || currentKey() !== key) return
  applyManagedProvider(provider)
  if (snapshot.protocol === 'geniex') {
    if (applyCapabilities(capabilities)) runtime.modelRevision += 1
  } else if (applyCapabilities(new Map())) {
    runtime.modelRevision += 1
  }
  invalidateState()
}

/** Serialize provider-config work on the instance that owns it. */
function providerTask(instance, operation) {
  const run = instance.providerChain.then(operation, operation)
  instance.providerChain = run.then(() => undefined, () => undefined)
  return run
}

/** One provider-build attempt for the current settings. */
async function syncProviderOnce(ctx) {
  const instance = runtime
  if (instance.disposed) return
  // Snapshot, not a live reference: a mode/source change during discovery must
  // make this attempt stale instead of mutating its own comparison key.
  const settings = { ...instance.settings }
  if (settings.mode === 'off') {
    await deleteProviders(ctx, managedProviderIds(settings))
    if (runtime !== instance || instance.disposed) return
    instance.settings.managedProviderId = null
    clearManagedState()
    return
  }
  if (runtime.bindError !== null) {
    const error = httpError(502, runtime.bindError)
    error.retryable = false
    throw error
  }
  const provider = await upsertProvider(ctx, settings)
  if (provider === null) return
  // The mode, source, or key may have changed while discovery was in flight.
  if (runtime !== instance || instance.disposed || !providerSettingsCurrent(settings)) return
  applyManagedProvider(provider)
  if (applyCapabilities(provider.capabilities)) runtime.modelRevision += 1
  runtime.capabilityRetryAt = 0
  invalidateState()
}

/**
 * Rebuild or remove the managed provider for the current settings.
 *
 * Discovery talks to GenieX, which serializes `/v1` requests while a model is
 * generating, so a transient failure is normal. `attempts` retries with
 * backoff and aborts as soon as a newer sync or a settings change supersedes
 * this one.
 */
function syncProvider(ctx, attempts = 1) {
  const instance = runtime
  if (instance.disposed) return Promise.resolve()
  const generation = ++runtime.syncGeneration
  const key = providerSettingsKey()
  runtime.pendingSync += 1
  invalidateState()
  const run = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (runtime !== instance || instance.disposed || generation !== runtime.syncGeneration) return
      try {
        await providerTask(instance, () => syncProviderOnce(ctx))
        return
      } catch (error) {
        if (runtime !== instance || instance.disposed || generation !== runtime.syncGeneration) return
        const superseded = providerSettingsKey() !== key || runtime.settings.mode === 'off'
        if (superseded || error?.retryable === false || attempt >= attempts - 1) throw error
        await delay(SYNC_RETRY_DELAYS[Math.min(attempt, SYNC_RETRY_DELAYS.length - 1)])
      }
    }
  })()
  return run.finally(() => {
    if (runtime !== instance || instance.disposed) return
    runtime.pendingSync = Math.max(0, runtime.pendingSync - 1)
    invalidateState()
  })
}

/** Start a provider sync without making the settings page wait for it. */
function startBackgroundSync(ctx, attempts) {
  const instance = runtime
  if (instance.disposed) return
  const key = providerSettingsKey()
  void syncProvider(ctx, attempts).catch((error) => {
    if (runtime !== instance || instance.disposed || providerSettingsKey() !== key) return
    runtime.settings.lastError = userError(error)
    invalidateState()
    runtime.logger?.warn?.(`[${SCOPE}] cannot refresh managed provider: ${userError(error)}`)
  })
}

function canMtp(model) {
  return runtime.settings.mtp
    && runtime.settings.protocol === 'geniex'
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
  const capability = runtime.modelCapabilities.get(model)
  return effectiveContext(runtime.settings, runtime.modelContexts.get(model) ?? null, capability?.runtime ?? '')
}

/**
 * The load parameters shared by warmup and requests. Keeping one producer is
 * what prevents a warmup from being thrown away by a mismatched first request.
 * @param model - managed model id.
 * @param mtp - the MTP decision for this request (defaults to the text path).
 */
function loadOptions(model, mtp = useMtp(model)) {
  return {
    vision: runtime.visionModels.has(model),
    context: modelLoadContext(model),
    mtp,
    mtpDraft: mtpDraftFor(model),
  }
}

/** The thinking capability of one managed model: true, false, or undefined. */
function modelReasoning(model) {
  const value = runtime.modelCapabilities.get(model)?.reasoningEfforts
  if (value === false) return false
  if (value !== undefined) return true
  return runtime.modelReasoning.get(model)
}

/** The model's `loaded_at` from a GenieX status snapshot, in epoch ms. */
function loadedAtFor(models, model) {
  const row = Array.isArray(models) ? models.find((entry) => entry?.id === model) : undefined
  const loadedAt = Date.parse(row?.loaded_at ?? '')
  return Number.isFinite(loadedAt) ? loadedAt : 0
}

/** Attribute part of one call's TTFT to a weight-load/queue wait. */
function applyLoadTiming(call, models) {
  const requestStart = call.requestStart
  if (requestStart === undefined || requestStart.model !== call.model) return
  if (requestStart.upstream !== runtime.settings.upstream) return
  const loadedAt = loadedAtFor(models, call.model)
  if (loadedAt <= 0 || loadedAt < requestStart.at || loadedAt > call.firstTokenAt) return
  const loadMs = Math.min(call.ttftMs, Math.max(0, Math.round(loadedAt - requestStart.at)))
  call.netTtftMs = Math.max(0, call.ttftMs - loadMs)
}

/** Project one turn's calls into the single metric the UI renders. */
function aggregateTurnMetric(metric) {
  const calls = metric.calls
  if (calls.length === 0) return null
  const last = calls[calls.length - 1]
  if (metric.hasToolCalls !== true) {
    return {
      provider: last.provider,
      model: last.model,
      ttftMs: last.netTtftMs,
      netTtftMs: last.netTtftMs,
      tps: last.tps,
      outputTokens: last.outputTokens,
      average: false,
      toolCalls: false,
    }
  }
  // Tool-call generations are excluded so the average reflects text/reasoning
  // prefill and decode, not tool-token formatting or tool execution.
  const usable = calls.filter((call) => call.toolCall !== true)
  const selected = usable.length > 0 ? usable : calls
  const avgTtft = Math.round(selected.reduce((sum, call) => sum + call.netTtftMs, 0) / selected.length)
  let tokens = 0
  let decodeMs = 0
  for (const call of selected) {
    if (call.outputTokens === null || call.decodeMs <= 0) continue
    tokens += call.outputTokens
    decodeMs += call.decodeMs
  }
  const avgTps = decodeMs > 0 ? Math.round(tokens / (decodeMs / 1000) * 10) / 10 : null
  return {
    provider: last.provider,
    model: last.model,
    ttftMs: avgTtft,
    netTtftMs: avgTtft,
    tps: avgTps,
    outputTokens: tokens,
    average: true,
    toolCalls: true,
    callCount: selected.length,
  }
}

/** Store one call's timing and token counts on its turn. */
function recordTurn(sessionId, turn, call) {
  const key = `${sessionId}:${turn}`
  let metric = runtime.turnMetrics.get(key)
  if (metric === undefined) {
    metric = { provider: call.provider, model: call.model, calls: [], hasToolCalls: false }
    runtime.turnMetrics.set(key, metric)
    trimMap(runtime.turnMetrics, 2000)
  }
  if (!metric.calls.some((existing) => existing.id === call.id)) {
    metric.calls.push(call)
    metric.calls.sort((left, right) => left.time - right.time)
    metric.provider = call.provider
    metric.model = call.model
    metric.hasToolCalls = metric.hasToolCalls === true || call.toolCall === true
  }
  if (call.provider !== PROVIDERS.geniex.id) return
  runtime.sessionProviders.add(sessionId)
  trimMap(runtime.sessionProviders, 2000)
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
          const metric = buildTurnMetric(event, first, starts.get(key) ?? first, step)
          if (metric !== null) recordTurn(session.id, turn, metric)
        }
      }
      if (index % 400 === 399) await new Promise((resolve) => setImmediate(resolve))
    }
    runtime.derivedSessions.add(session.id)
    trimMap(runtime.derivedSessions, 200)
  })().catch((error) => {
    // Mark the session as processed so the client stops polling a history that
    // cannot be replayed.
    runtime.logger?.warn?.(`[${SCOPE}] cannot derive session metrics: ${userError(error)}`)
    runtime.derivedSessions.add(session.id)
    trimMap(runtime.derivedSessions, 200)
  }).finally(() => {
    runtime.deriving.delete(session.id)
  })
  runtime.deriving.set(session.id, promise)
  return promise
}

/**
 * Stream one upstream response to the client, rewriting reasoning fields.
 * @param upstream - upstream response.
 * @param res - client response.
 * @param options.managed - whether this is a managed Qwen request.
 * @param options.onUsage - usage callback for MTP accounting.
 */
function writeProxyResponse(upstream, res, { managed, onUsage }) {
  const logger = runtime.logger
  const headers = { ...upstream.headers }
  for (const name of [...HOP_BY_HOP, 'content-length', 'transfer-encoding']) delete headers[name]
  headers['cache-control'] = 'no-store'
  const status = upstream.statusCode ?? 502
  const contentType = String(upstream.headers['content-type'] ?? '')
  const streaming = contentType.includes('text/event-stream')
  // A compressed body cannot be parsed or rewritten; pass it through instead
  // of corrupting it, even though the request asked for `identity`.
  const encoded = headers['content-encoding'] !== undefined
  const rewriting = managed && !encoded && (streaming || contentType.includes('application/json'))

  const finish = (value) => {
    if (res.writableEnded) return
    try {
      res.end(value)
    } catch {
      res.destroy()
    }
  }

  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  upstream.on('error', () => res.destroy())
  upstream.on('aborted', () => res.destroy())

  const startResponse = () => {
    try {
      res.writeHead(status, headers)
      res.flushHeaders?.()
      return true
    } catch {
      upstream.destroy()
      return false
    }
  }

  if (!rewriting) {
    if (!startResponse()) return
    res.socket?.setNoDelay(true)
    upstream.pipe(res)
    return
  }

  if (!streaming) {
    const chunks = []
    let size = 0
    upstream.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_RESPONSE) {
        upstream.destroy()
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: { message: 'upstream response is too large' } })
        else res.destroy()
        return
      }
      chunks.push(chunk)
    })
    upstream.on('close', () => {
      if (!upstream.complete && !res.writableEnded) res.destroy()
    })
    upstream.on('end', () => {
      if (res.writableEnded || res.destroyed) return
      const raw = Buffer.concat(chunks)
      let payload
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        if (!startResponse()) return
        finish(raw)
        return
      }
      onUsage?.(payload?.usage)
      if (Array.isArray(payload.choices)) {
        payload.choices = payload.choices.map((choice) => (
          choice !== null && typeof choice === 'object'
            ? { ...choice, message: rewriteMessage(choice.message) }
            : choice
        ))
      }
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      headers['content-length'] = String(body.length)
      if (!startResponse()) return
      finish(body)
    })
    return
  }

  if (!startResponse()) return
  res.socket?.setNoDelay(true)
  const decoder = new StringDecoder('utf8')
  const state = createThinkState()
  const meta = { onUsage }
  let buffer = ''
  let waitingDrain = false
  const write = (value) => {
    if (value === '' || res.writableEnded || res.destroyed) return
    let ok = true
    try {
      ok = res.write(value)
    } catch {
      upstream.destroy()
      return
    }
    if (!ok && !waitingDrain) {
      waitingDrain = true
      upstream.pause()
      res.once('drain', () => {
        waitingDrain = false
        if (!upstream.destroyed) upstream.resume()
      })
    }
  }
  const emit = (raw) => {
    let value
    try {
      value = transformSseEvent(raw, state, meta)
    } catch (error) {
      logger?.warn?.(`[${SCOPE}] cannot rewrite stream event: ${userError(error)}`)
      upstream.destroy()
      res.destroy()
      return false
    }
    write(value)
    return true
  }
  upstream.on('data', (chunk) => {
    buffer += decoder.write(chunk)
    let start = 0
    for (;;) {
      const lf = buffer.indexOf('\n\n', start)
      const crlf = buffer.indexOf('\r\n\r\n', start)
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
      if (!emit(buffer.slice(start, index))) return
      start = index + width
    }
    if (start > 0) buffer = buffer.slice(start)
    if (buffer.length > MAX_EVENT_BUFFER) {
      logger?.warn?.(`[${SCOPE}] upstream event exceeded ${MAX_EVENT_BUFFER} bytes`)
      upstream.destroy()
      res.destroy()
    }
  })
  upstream.on('end', () => {
    buffer += decoder.end()
    if (buffer.trim() !== '' && !emit(buffer)) return
    finish()
  })
  upstream.on('close', () => {
    if (!upstream.complete && !res.writableEnded) res.destroy()
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
  let clientGone = false
  let upstreamReq = null
  let upstreamRes = null
  const destroyUpstream = () => {
    upstreamRes?.destroy()
    upstreamReq?.destroy()
  }
  const clientWentAway = () => {
    clientGone = true
    destroyUpstream()
  }
  req.on('data', (chunk) => {
    if (rejected || clientGone) return
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
  req.on('error', (error) => {
    clientGone = true
    destroyUpstream()
    logger.warn(`[${SCOPE}] proxy request failed: ${userError(error)}`)
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: { message: userError(error) } })
  })
  req.on('aborted', () => {
    rejected = true
    clientWentAway()
  })
  res.on('close', () => {
    if (!res.writableEnded) clientWentAway()
  })
  res.on('error', clientWentAway)
  req.on('end', () => {
    if (rejected || clientGone) return
    let body = Buffer.concat(chunks)
    let managed = false
    let activeModel = ''
    let mtpActive = false
    if (settings.mode === 'auto' && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        if (ownsModel(parsed?.model)) {
          const model = parsed.model
          managed = true
          activeModel = model
          const reasoning = modelReasoning(model)
          const vision = runtime.visionModels.has(model)
          const media = bodyHasMedia(parsed)
          const thinking = reasoning === false ? false : requestedThinking(parsed)
          const mtp = media && vision
            ? canMtp(model) && runtime.mtpApproved.has(model)
            : useMtp(model)
          mtpActive = mtp
          body = Buffer.from(JSON.stringify(applyRequestDefaults(parsed, settings, {
            ...loadOptions(model, mtp),
            thinking,
            reasoning,
            preserveThinking: supportsPreserveThinking(model),
          })), 'utf8')
          if (media && vision) consumeMtpChoice(model)
        }
      } catch {
        // Preserve non-JSON bodies unchanged.
      }
    }
    if (clientGone) return
    headers['content-length'] = String(body.length)
    try {
      upstreamReq = transport.request(upstreamUrl, { method: req.method, headers }, (upstreamResponse) => {
        if (clientGone) {
          upstreamResponse.destroy()
          return
        }
        upstreamRes = upstreamResponse
        writeProxyResponse(upstreamResponse, res, {
          managed,
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
}

/** The reply-only preset labels for one locale. */
function replyOnlyLabels(locale) {
  return locale.startsWith('en')
    ? { name: 'Reply Only', description: 'Tool calls are hidden and denied; replies stay plain text.' }
    : { name: '仅回复', description: '禁止工具调用，仅进行纯文本对话。' }
}

function replyOnlyPreset(presets, locale) {
  const current = presets[REPLY_ONLY_KEY]
  const labels = replyOnlyLabels(locale)
  return {
    sandbox: current?.sandbox ?? 'read-only',
    approval: current?.approval ?? 'never',
    name: labels.name,
    description: labels.description,
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
  const labels = replyOnlyLabels(locale)
  if (entry === null) return { updated: false, ...labels }
  const presets = config.presets !== null && typeof config.presets === 'object' ? config.presets : {}
  if (samePreset(presets[REPLY_ONLY_KEY], replyOnlyPreset(presets, locale))) return { updated: false, ...labels }
  await runConfigEdit(ctx, entry, (current, inherited) => {
    const base = { ...(inherited ?? {}), ...(current ?? {}) }
    const merged = { ...((inherited ?? {}).presets ?? {}), ...((current ?? {}).presets ?? {}) }
    return { ...base, presets: { ...merged, [REPLY_ONLY_KEY]: replyOnlyPreset(merged, locale) } }
  })
  return { updated: true, ...labels }
}

/** Wait for the background provider sync to publish the requested model. */
async function waitForManagedModel(ctx, model, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (!runtime.disposed && Date.now() < deadline) {
    if (runtime.managedModels.has(model)) return true
    if (runtime.pendingSync === 0) break
    await delay(200)
  }
  if (runtime.managedModels.has(model)) return true
  try {
    await refreshManagedModels(ctx)
  } catch {
    // The caller reports the model as unavailable.
  }
  return runtime.managedModels.has(model)
}

async function warmUpModel(ctx, settings, model, options) {
  const url = upstreamURL(settings, 'chat/completions')
  // The warm-up path returns before generation, but GenieX still keys the
  // loaded model on the request's load fields. Produce those fields through
  // the same normalizer as a live request so `nctx`, compute, `vit_compute`,
  // and the MTP draft fields cannot drift apart.
  const body = applyRequestDefaults({
    model,
    // GenieX treats a lone system message as a warm-up: the model loads with
    // these exact load parameters and no prefill or decoding runs.
    messages: [{ role: 'system', content: `You are ${shortModelName(model)}. Load the model; do not answer.` }],
    stream: false,
    // Keep the completion reservation at the provider's normal cap. GenieX
    // raises NCtx to max_completion_tokens for llama.cpp, and a live request
    // sends the same provider limit.
    max_completion_tokens: runtime.modelMaxTokens.get(model)
      ?? modelTokenLimit(settings, runtime.modelCapabilities.get(model), options.context),
  }, settings, {
    ...options,
    thinking: false,
    reasoning: false,
    preserveThinking: false,
  })
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...await credentialHeader(ctx, settings) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw httpError(504, 'model warmup timed out')
    }
    throw httpError(502, `model warmup failed: ${userError(error)}`)
  }
  const raw = await response.text()
  if (!response.ok) {
    let detail = ''
    try {
      const parsed = JSON.parse(raw)
      detail = text(typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message)
    } catch {
      // The status alone is still useful.
    }
    throw httpError(502, `model warmup failed: HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
  }
  let usage
  try {
    usage = JSON.parse(raw)?.usage
  } catch {
    usage = undefined
  }
  return { elapsedMs: Date.now() - startedAt, usage }
}

/** Read GenieX's `/status` body independently of the warmup setting. */
async function readGeniexStatus(ctx, timeout = 1500) {
  const settings = runtime.settings
  if (settings.protocol !== 'geniex') return null
  try {
    const url = new URL(settings.upstream)
    url.pathname = '/status'
    url.search = ''
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...await credentialHeader(ctx, settings) },
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/** Read the loaded-model state from GenieX's `/status`. */
async function readModelStatus(ctx) {
  const settings = runtime.settings
  if (!(settings.mode === 'auto' && settings.protocol === 'geniex' && settings.warm === true)) {
    return { active: false, models: [], warming: [], revision: runtime.loadRevision, revisions: Object.fromEntries(runtime.loadRevisions) }
  }
  const cached = runtime.statusCache
  if (cached.key === settings.upstream && Date.now() - cached.at < 1500) {
    return {
      ...cached.value,
      warming: [...runtime.warmingModels],
      revision: runtime.loadRevision,
      revisions: Object.fromEntries(runtime.loadRevisions),
    }
  }
  let value = { active: true, models: [], warming: [] }
  const body = await readGeniexStatus(ctx, 2500)
  if (body !== null) {
    const models = Array.isArray(body?.models) ? body.models.filter((model) => typeof model?.id === 'string') : []
    value = {
      active: true,
      models: models.map((model) => model.id),
      states: Object.fromEntries(models.map((model) => [model.id, model.state])),
    }
  }
  value.warming = [...runtime.warmingModels]
  value.revision = runtime.loadRevision
  value.revisions = Object.fromEntries(runtime.loadRevisions)
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
    pendingSync: runtime.pendingSync > 0,
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
  runtime.capabilityRetryAt = Date.now() + 30000
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
      if (!runtime.mtpDrafts.has(model)) throw httpError(400, 'model has no MTP draft')
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
      invalidateStatus()
      invalidateState()
      if (mode === 'off') {
        // Removing the provider is local config work; an in-flight discovery
        // sees the new mode when it tries to commit and skips.
        runtime.syncGeneration += 1
        try {
          await deleteProviders(ctx, managedProviderIds(runtime.settings))
          runtime.settings.managedProviderId = null
          clearManagedState()
          runtime.settings.lastError = null
        } catch (error) {
          runtime.settings.lastError = userError(error)
        }
        try {
          await persistSettings()
        } catch (error) {
          runtime.settings.lastError = userError(error)
          invalidateState()
          throw httpError(500, userError(error))
        }
        return readState(ctx)
      }
      try {
        await persistSettings()
      } catch (error) {
        runtime.settings.mode = previous
        runtime.settings.lastError = userError(error)
        invalidateState()
        throw httpError(500, userError(error))
      }
      // Discovery can take seconds; answer first, then build in the background.
      startBackgroundSync(ctx, 3)
      return readState(ctx)
    },
    turnStats: async (payload) => {
      const sessionId = text(payload?.sessionId)
      const turn = Number(payload?.turn)
      if (sessionId === '' || !Number.isInteger(turn)) return null
      const key = `${sessionId}:${turn}`
      if (runtime.turnMetrics.get(key) === undefined) {
        const session = ctx.sessions.get(sessionId)
        if (session === undefined) return null
        await deriveSessionMetrics(session)
      }
      const metric = runtime.turnMetrics.get(key)
      if (metric === undefined) return null
      if (metric.loadPromise === undefined) {
        const pending = metric.calls.filter((call) => call.requestStart !== undefined && call.toolCall !== true)
        metric.loadPromise = pending.length === 0
          ? Promise.resolve()
          : readGeniexStatus(ctx, 1500).then((body) => {
              const models = Array.isArray(body?.models) ? body.models : null
              for (const call of pending) applyLoadTiming(call, models)
            }).catch(() => {})
      }
      await metric.loadPromise
      return aggregateTurnMetric(metric)
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
        const currentSettings = () => {
          const settings = runtime.settings
          if (settings.protocol !== 'geniex') throw httpError(409, 'model warmup is GenieX-only')
          if (settings.mode !== 'auto' || !settings.warm) throw httpError(409, 'model warmup is disabled')
          return settings
        }
        currentSettings()
        const model = text(payload?.model)
        if (model === '') throw httpError(400, 'unknown managed model')
        // A new conversation can ask for warmup before the background provider
        // sync has published the catalog. Wait briefly instead of failing with
        // a misleading "unknown model".
        if (!(await waitForManagedModel(ctx, model))) {
          throw httpError(409, runtime.settings.lastError ?? 'model is not available yet')
        }
        if (generation !== runtime.warmGeneration) return { warmed: false, skipped: true }
        // The user may have disabled warmup or changed the source while this
        // request waited for the catalog.
        const settings = currentSettings()
        if (runtime.warmingModels.has(model)) return { warmed: false, model, skipped: true }
        if (!runtime.modelCapabilities.has(model)) {
          await refreshManagedModels(ctx)
          if (!runtime.managedModels.has(model)) throw httpError(409, 'model is not available yet')
        }
        runtime.warmingModels.add(model)
        invalidateStatus()
        try {
          const result = await warmUpModel(ctx, settings, model, loadOptions(model))
          return { warmed: true, model, ...result }
        } catch (error) {
          runtime.logger?.warn?.(`[${SCOPE}] warmup failed for ${model}: ${userError(error)}`)
          throw error
        } finally {
          runtime.warmingModels.delete(model)
          invalidateStatus()
        }
      }
      const result = runtime.warmQueue.then(operation, operation)
      runtime.warmQueue = result.then(() => undefined, () => undefined)
      return result
    },
    save: async (payload) => {
      const previous = runtime.settings
      const patch = {}
      for (const key of SAVE_FIELDS) {
        if (payload !== null && typeof payload === 'object' && Object.hasOwn(payload, key)) patch[key] = payload[key]
      }
      if (patch.mode !== undefined && !SUPPORTED_MODES.includes(patch.mode)) throw httpError(400, 'invalid mode')
      if (typeof patch.upstream !== 'string') delete patch.upstream
      else assertUpstream(patch.upstream)
      if (typeof patch.apiKeyEnv !== 'string') delete patch.apiKeyEnv
      else assertApiKeyRef(patch.apiKeyEnv)
      const next = normalizeSettings({
        ...previous,
        ...patch,
        proxyPort: previous.proxyPort,
      })
      const providerChanged = next.protocol !== previous.protocol
        || next.upstream !== previous.upstream
        || apiKeyRef(next) !== apiKeyRef(previous)
        || next.contextWindow !== previous.contextWindow
        || next.maxOutputTokens !== previous.maxOutputTokens
        || next.autoNctx !== previous.autoNctx
      const providerRemoval = next.mode === 'off' && next.managedProviderId !== null
      const requiresSync = next.mode !== previous.mode
        || providerChanged
        || providerRemoval
        || (next.mode === 'auto' && next.managedProviderId === null)
      const loadFlagsChanged = next.contextWindow !== previous.contextWindow
        || next.autoNctx !== previous.autoNctx
        || next.mtp !== previous.mtp
        || next.mtpDraftTokens !== previous.mtpDraftTokens
        || next.mtpDraftMin !== previous.mtpDraftMin
        || next.mtpDraftPMin !== previous.mtpDraftPMin
        || next.compute !== previous.compute
        || next.vitCompute !== previous.vitCompute
      const loadChanged = requiresSync
        || loadFlagsChanged
        || next.maxOutputTokens !== previous.maxOutputTokens
      const revisionBefore = runtime.modelRevision
      runtime.settings = next
      invalidateState()
      invalidateStatus()
      try {
        await persistSettings()
      } catch (error) {
        runtime.settings = previous
        invalidateState()
        throw httpError(500, userError(error))
      }
      runtime.settings.lastError = null
      if (providerChanged) {
        runtimeCapabilities(ctx).invalidate(next.upstream)
        runtime.capabilityRetryAt = 0
      }
      if (requiresSync) startBackgroundSync(ctx, 3)
      if (loadFlagsChanged) {
        bumpLoadRevision(runtime.managedModels)
      }
      if (loadChanged && runtime.modelRevision === revisionBefore) runtime.modelRevision += 1
      return readState(ctx)
    },
    apply: async () => {
      runtimeCapabilities(ctx).invalidate(runtime.settings.upstream)
      runtime.capabilityRetryAt = 0
      runtime.settings.lastError = null
      invalidateState()
      startBackgroundSync(ctx, 3)
      return readState(ctx)
    },
    remove: async () => {
      runtime.syncGeneration += 1
      invalidateState()
      try {
        await providerTask(runtime, async () => {
          await deleteProviders(ctx, managedProviderIds(runtime.settings))
          runtime.settings.managedProviderId = null
        })
        clearManagedState()
        runtime.settings.lastError = null
      } catch (error) {
        runtime.settings.lastError = userError(error)
      }
      try {
        await persistSettings()
      } catch (error) {
        runtime.settings.lastError = userError(error)
        invalidateState()
      }
      return readState(ctx)
    },
  }
  return api
}

/** Serialize the settings that are actually written to disk. */
function settingsForStore(settings = runtime.settings) {
  const { lastError, ...stored } = settings
  return stored
}

function settingsFingerprint(settings = runtime.settings) {
  return JSON.stringify(settingsForStore(settings))
}

/** Serialize settings writes. */
function persistSettings() {
  const instance = runtime
  const run = async () => {
    if (instance.disposed) return
    await mkdir(instance.profileDir, { recursive: true })
    const body = `${JSON.stringify(settingsForStore(instance.settings), null, 2)}\n`
    const temporary = `${instance.storePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, body, 'utf8')
    if (instance.disposed) {
      try {
        await unlink(temporary)
      } catch {
        // The disposed instance leaves no settings behind.
      }
      return
    }
    try {
      await rename(temporary, instance.storePath)
    } catch {
      await writeFile(instance.storePath, body, 'utf8')
      try {
        await unlink(temporary)
      } catch {
        // A leftover temporary file is harmless.
      }
    }
  }
  const next = instance.persistChain.then(run, run)
  instance.persistChain = next.then(() => undefined, () => undefined)
  return next
}

/** Bind the loopback proxy, sliding to the next port when one is taken. */
async function startProxy() {
  const instance = runtime
  if (instance.disposed) return null
  const server = http.createServer((req, res) => handleProxyRequest(req, res))
  const preferred = instance.settings.proxyPort
  let bound = null
  for (let offset = 0; offset < PROXY_PORT_TRIES; offset += 1) {
    const port = preferred + offset
    if (port > 65535) break
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
      if (error?.code !== 'EADDRINUSE') {
        instance.logger.warn(`[${SCOPE}] cannot bind proxy on ${port}: ${userError(error)}`)
        break
      }
    }
  }
  if (bound === null) {
    instance.bindError = `Cannot bind the Qwen mode proxy near port ${preferred}`
    invalidateState()
    return null
  }
  if (runtime !== instance || instance.disposed) {
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    return null
  }
  instance.bindError = null
  server.on('error', (error) => {
    instance.logger?.warn?.(`[${SCOPE}] proxy server error: ${userError(error)}`)
  })
  if (instance.settings.proxyPort !== bound) {
    instance.settings.proxyPort = bound
    invalidateState()
    await persistSettings().catch(() => {})
  }
  return server
}

/** Keep the per-agent tool restriction in sync with the reply-only preset. */
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
      const dispose = scoped.tools.restrict({ allow: [] })
      if (typeof dispose === 'function') runtime.replyRestrictions.set(agent.id, dispose)
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
      let rejection
      try {
        rejection = ctx.connection.requestRejection(req)
      } catch {
        rejection = 'forbidden'
      }
      if (rejection !== undefined) {
        sendJson(res, 403, { ok: false, error: { message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { message: 'POST only' } })
        return
      }
      // Same-origin admission is checked above; also refuse a body that a
      // cross-site form or `fetch(..., { mode: 'no-cors' })` could send without
      // a preflight. Every method reads JSON, so nothing else is legitimate.
      const mediaType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== 'application/json') {
        sendJson(res, 415, { ok: false, error: { message: 'content-type must be application/json' } })
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
  // A reinstall can start before every async task of the previous instance has
  // settled. The flag lets those tasks stop instead of writing settings or
  // config after their plugin has been disposed.
  ctx.effect(() => () => { instance.disposed = true }, `${SCOPE}: lifecycle`)
  runtime.logger = loggerFor(ctx, SCOPE)
  runtime.profileDir = text(process.env.DSH_PROFILE_DIR) || process.cwd()
  runtime.storePath = join(runtime.profileDir, STORE_FILE)

  let stored = null
  let loaded = normalizeSettings({})
  try {
    stored = JSON.parse(await readFile(runtime.storePath, 'utf8'))
    loaded = normalizeSettings(stored)
  } catch (error) {
    if (error?.code !== 'ENOENT') runtime.logger.warn(`[${SCOPE}] cannot read settings: ${userError(error)}`)
  }
  runtime.settings = loaded
  runtime.settings.lastError = null
  if (stored === null || settingsFingerprint(loaded) !== settingsFingerprint(stored)) {
    await persistSettings().catch((error) => runtime.logger.warn(`[${SCOPE}] cannot save settings: ${userError(error)}`))
  }
  if (instance.disposed) return

  applyManagedProvider(readManagedProvider(ctx, runtime.settings).provider)
  const api = createApi(ctx)
  serializeMutations(api)

  ctx.effect(() => registerWebApi(ctx, api), `${SCOPE}: settings API`)

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type === 'request/header') {
      const current = runtime.currentSteps.get(session.id)
      const model = event.data?.header?.config?.model
      if (current !== undefined && typeof model === 'string') {
        runtime.requestStarts.set(`${session.id}:${current.turn}:${current.step}`, {
          at: event.time,
          model,
          upstream: runtime.settings.upstream,
        })
        trimMap(runtime.requestStarts, 2000)
      }
      return
    }
    if (event.type === 'turn/end') {
      runtime.currentSteps.delete(session.id)
      return
    }
    const turn = event.data?.turn
    const step = event.data?.step
    if (!Number.isInteger(turn) || !Number.isInteger(step)) return
    const key = `${session.id}:${turn}:${step}`
    if (event.type === 'step/start') {
      runtime.currentSteps.set(session.id, { turn, step })
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
    const requestStart = runtime.requestStarts.get(key) ?? null
    runtime.stepStarts.delete(key)
    runtime.firstTokens.delete(key)
    runtime.requestStarts.delete(key)
    const metric = buildTurnMetric(event, first, start, step)
    if (metric === null) return
    metric.requestStart = requestStart ?? undefined
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
  if (instance.disposed) {
    if (server !== null) {
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
    return
  }
  if (server !== null) {
    ctx.effect(() => () => {
      instance.disposed = true
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }, `${SCOPE}: proxy server`)
  }

  // Provider discovery talks to the upstream, so it must never delay
  // activation: a stopped GenieX would otherwise stall the plugin (and its
  // settings page) for the full discovery timeout. The sync below retries on
  // its own, so a congested link only delays the provider, not the plugin.
  const startupSync = async () => {
    if (runtime !== instance || instance.disposed) return
    const before = settingsFingerprint()
    try {
      await syncProvider(ctx, 4)
      if (runtime !== instance || instance.disposed) return
      runtime.settings.lastError = null
      invalidateState()
      if (settingsFingerprint() !== before) await persistSettings()
    } catch (error) {
      if (runtime !== instance || instance.disposed) return
      runtime.settings.lastError = userError(error)
      invalidateState()
      runtime.logger.warn(`[${SCOPE}] cannot refresh managed provider: ${userError(error)}`)
    }
  }
  void startupSync()
}
