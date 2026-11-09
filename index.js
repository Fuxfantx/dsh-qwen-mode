/**
 * Host half of the Qwen mode bundle.
 *
 * Starts a loopback OpenAI-compatible proxy and maintains dedicated
 * `llm-pi-ai` providers (`From GenieX`, `From QwenCloud`, ...) that point at
 * it. The proxy normalizes Qwen thinking controls and rewrites inline
 * `<think>` reasoning into `reasoning_content`.
 *
 * @module dsh-qwen-mode
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const SCOPE = 'qwen-mode'
const API_PREFIX = '/qwen-mode/api'
const STORE_FILE = 'qwen-mode.json'
const MAX_BODY = 8 * 1024 * 1024
const DEFAULT_PORT = 18182
const VIT_COMPUTE_FIELD = { cpu: 'CPU', gpu: 'GPU', npu: 'HTP2' }

const DEFAULTS = {
  version: 1,
  mode: 'off',
  warm: false,
  protocol: 'geniex',
  upstream: 'http://127.0.0.1:18181',
  apiKeyEnv: '',
  proxyPort: DEFAULT_PORT,
  managedProviderId: null,
  contextWindow: 262144,
  maxOutputTokens: 131072,
  compute: '',
  vitCompute: 'npu',
  temperature: null,
  topP: null,
  topK: null,
  repetitionPenalty: null,
  presencePenalty: null,
  frequencyPenalty: null,
}

/** Services required by the proxy, provider maintenance, and settings API. */
export const inject = ['webServer', 'connection', 'configEditor', 'credentials', 'permissionPresets', 'sessions', 'agents', 'tools']

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function positiveIntOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function streamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record?.type === 'chunk' && record.chunk?.type !== 'usage') return record.time
    if (record?.type === 'text-chunks' || record?.type === 'reasoning-chunks') {
      if (Array.isArray(record.texts) && record.texts.some((text) => text !== '')) return record.time0
    }
    if (record?.type === 'tool-call-chunks' && record.name !== undefined) return record.time0
  }
  return undefined
}

/** Build the compact UI metric for one settled assistant message. */
function turnMetric(event, first, start) {
  const source = event.data?.message?.source
  if (typeof source?.provider !== 'string' || typeof source?.model !== 'string') return null
  const outputTokens = event.data?.usage?.outputTokens ?? null
  const decodeMs = Math.max(1, event.time - first)
  return {
    provider: source.provider,
    model: source.model,
    ttftMs: Math.max(0, Math.round(first - start)),
    tps: outputTokens === null ? null : Math.round(outputTokens / (decodeMs / 1000) * 10) / 10,
    outputTokens,
  }
}

function loggerFor(ctx) {
  try {
    const scoped = ctx.logger(SCOPE)
    if (scoped !== undefined && scoped !== null && typeof scoped.info === 'function') return scoped
  } catch {}
  const base = ctx.logger ?? {}
  return {
    info: (message) => base.info?.(message),
    warn: (message) => base.warn?.(message),
    error: (message) => base.error?.(message),
  }
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(httpError(413, 'request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(value !== null && typeof value === 'object' ? value : {})
      } catch {
        reject(httpError(400, 'request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const port = typeof source.proxyPort === 'number' && Number.isInteger(source.proxyPort) && source.proxyPort > 0 && source.proxyPort < 65536
    ? source.proxyPort
    : DEFAULT_PORT
  const protocol = source.protocol === 'qwen' ? 'qwen' : 'geniex'
  const contextWindow = positiveIntOrNull(source.contextWindow)
  const effectiveContext = contextWindow ?? (protocol === 'qwen' ? DEFAULTS.contextWindow : null)
  const maxOutput = positiveInt(source.maxOutputTokens, DEFAULTS.maxOutputTokens)
  return {
    version: 1,
    mode: ['off', 'auto'].includes(source.mode)
      ? source.mode
      : source.enabled === true || source.mode === 'always' ? 'auto' : 'off',
    warm: source.warm === true,
    protocol,
    upstream: text(source.upstream).replace(/\/+$/u, '') || DEFAULTS.upstream,
    apiKeyEnv: text(source.apiKeyEnv),
    proxyPort: port,
    managedProviderId: text(source.managedProviderId) || null,
    contextWindow,
    maxOutputTokens: effectiveContext === null ? maxOutput : Math.min(maxOutput, effectiveContext),
    compute: text(source.compute).slice(0, 100),
    vitCompute: ['cpu', 'gpu', 'npu'].includes(source.vitCompute) ? source.vitCompute : DEFAULTS.vitCompute,
    temperature: numberOrNull(source.temperature),
    topP: numberOrNull(source.topP),
    topK: numberOrNull(source.topK),
    repetitionPenalty: numberOrNull(source.repetitionPenalty),
    presencePenalty: numberOrNull(source.presencePenalty),
    frequencyPenalty: numberOrNull(source.frequencyPenalty),
    lastError: text(source.lastError) || null,
  }
}

function providerIdFor(protocol) {
  return protocol === 'qwen' ? 'from-qwencloud' : 'from-geniex'
}

function providerNameFor(protocol) {
  return protocol === 'qwen' ? 'From QwenCloud' : 'From GenieX'
}

function proxyBaseURL(settings) {
  return `http://127.0.0.1:${settings.proxyPort}/v1`
}

function apiKeyRef(settings) {
  return text(settings.apiKeyEnv) || 'local'
}

function upstreamURL(settings, path) {
  const base = new URL(settings.upstream)
  let pathname = base.pathname.replace(/\/+$/u, '')
  if (settings.protocol === 'geniex' && !pathname.endsWith('/v1')) pathname += '/v1'
  base.pathname = `${pathname}/${path}`
  base.search = ''
  base.hash = ''
  return base
}

let geniexCacheRootPromise = null
function geniexCacheRoot() {
  if (geniexCacheRootPromise !== null) return geniexCacheRootPromise
  geniexCacheRootPromise = new Promise((resolveRoot) => {
    execFile(
      process.platform === 'win32' ? 'geniex.exe' : 'geniex',
      ['list'],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolveRoot(join(homedir(), '.cache', 'geniex', 'models'))
          return
        }
        const match = /Models cached in\s+(.+)/iu.exec(stdout)
        resolveRoot(match === null ? join(homedir(), '.cache', 'geniex', 'models') : match[1].trim())
      },
    )
  })
  return geniexCacheRootPromise
}

function thinkingEnabled(body) {
  if (typeof body.enable_think === 'boolean') return body.enable_think
  if (typeof body.enable_thinking === 'boolean') return body.enable_thinking
  const effort = body.reasoning_effort
  if (typeof effort === 'string') return !['off', 'none'].includes(effort.toLowerCase())
  return true
}

function applyRequestDefaults(body, settings, vision = false) {
  const output = { ...body }
  const thinking = thinkingEnabled(body)
  if (settings.protocol === 'qwen') {
    output.enable_thinking = thinking
    output.preserve_thinking = true
    delete output.enable_think
  } else {
    output.enable_think = thinking
    delete output.enable_thinking
    delete output.reasoning_effort
    output.reasoning_format = 'none'
    if (settings.compute !== '') output.compute = settings.compute
    if (vision) output.vit_compute = VIT_COMPUTE_FIELD[settings.vitCompute]
  }
  const fill = (key, value) => {
    if (value !== null && output[key] === undefined) output[key] = value
  }
  fill('temperature', settings.temperature)
  fill('top_p', settings.topP)
  fill('top_k', settings.topK)
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

function thinkState(assumeReasoning = false) {
  return { buffer: '', inThink: false, assumeReasoning, separated: false, pending: false }
}

/** Locate the first Markdown heading that likely starts the final answer. */
function headingStart(value) {
  const match = /(?:^|\n\n)(?=#{1,6}\s)/mu.exec(value)
  if (match === null) return -1
  return match.index + (match[0] === '\n\n' ? 2 : 0)
}

function safePrefix(value) {
  const index = value.lastIndexOf('<')
  if (index === -1) return value.length
  const tail = value.slice(index)
  return ['<think>', '</think>'].some((tag) => tag.startsWith(tail)) ? index : value.length
}

function pushPiece(out, type, value) {
  if (value !== '') out.push({ type, text: value })
}

function feedThink(value, state) {
  state.buffer += value
  const out = []
  while (state.buffer !== '') {
    if (!state.inThink) {
      if (state.pending) {
        const heading = headingStart(state.buffer)
        if (heading !== -1) {
          pushPiece(out, 'reasoning', state.buffer.slice(0, heading))
          state.buffer = state.buffer.slice(heading)
          state.pending = false
          state.separated = true
          continue
        }
        if (state.buffer.length <= 1200) break
        pushPiece(out, 'content', state.buffer)
        state.buffer = ''
        state.pending = false
        state.separated = true
        continue
      }
      if (state.separated) {
        const safe = safePrefix(state.buffer)
        if (safe > 0) {
          pushPiece(out, 'content', state.buffer.slice(0, safe))
          state.buffer = state.buffer.slice(safe)
        }
        break
      }
      const open = state.buffer.indexOf('<think>')
      const close = state.buffer.indexOf('</think>')
      if (open !== -1 && (close === -1 || open < close)) {
        pushPiece(out, 'content', state.buffer.slice(0, open))
        state.buffer = state.buffer.slice(open + 7)
        state.inThink = true
        continue
      }
      if (close !== -1) {
        pushPiece(out, 'reasoning', state.buffer.slice(0, close))
        state.buffer = state.buffer.slice(close + 8)
        state.inThink = false
        state.separated = true
        state.pending = true
        continue
      }
      if (state.assumeReasoning && !state.separated) {
        const parts = state.buffer.split('\n\n')
        if (parts.length > 1) {
          const held = parts.pop()
          pushPiece(out, 'reasoning', parts.join('\n\n'))
          state.buffer = held
          state.separated = true
          state.pending = true
          continue
        }
        break
      }
      const safe = safePrefix(state.buffer)
      if (safe > 0) {
        pushPiece(out, 'content', state.buffer.slice(0, safe))
        state.buffer = state.buffer.slice(safe)
      }
      break
    }
    const close = state.buffer.indexOf('</think>')
    if (close === -1) {
      const safe = safePrefix(state.buffer)
      if (safe > 0) {
        pushPiece(out, 'reasoning', state.buffer.slice(0, safe))
        state.buffer = state.buffer.slice(safe)
      }
      break
    }
    pushPiece(out, 'reasoning', state.buffer.slice(0, close))
    state.buffer = state.buffer.slice(close + 8)
    state.inThink = false
    state.separated = true
    state.pending = true
  }
  return out
}

function flushThink(state) {
  const out = []
  if (state.buffer !== '') {
    if (state.pending) {
      const heading = headingStart(state.buffer)
      if (heading !== -1) {
        pushPiece(out, 'reasoning', state.buffer.slice(0, heading))
        pushPiece(out, 'content', state.buffer.slice(heading))
      } else {
        pushPiece(out, 'content', state.buffer)
      }
      state.pending = false
      state.buffer = ''
      return out
    }
    const type = state.inThink ? 'reasoning' : 'content'
    out.push({ type, text: state.buffer })
    state.buffer = ''
  }
  return out
}

function rewriteMessage(message, state) {
  if (message === null || typeof message !== 'object' || typeof message.content !== 'string') return message
  const pieces = [...feedThink(message.content, state), ...flushThink(state)]
  const reasoning = pieces.filter((piece) => piece.type === 'reasoning').map((piece) => piece.text).join('')
  const content = pieces.filter((piece) => piece.type === 'content').map((piece) => piece.text).join('')
  return {
    ...message,
    content,
    ...reasoning === '' ? {} : { reasoning_content: `${message.reasoning_content ?? ''}${reasoning}` },
  }
}

function rewriteChunk(chunk, state) {
  if (chunk === null || typeof chunk !== 'object' || !Array.isArray(chunk.choices)) return [chunk]
  if (chunk.choices.length === 0) return [chunk]
  const out = []
  for (const choice of chunk.choices) {
    const delta = choice?.delta
    if (delta === null || typeof delta !== 'object' || typeof delta.content !== 'string') {
      out.push({ ...chunk, choices: [choice] })
      continue
    }
    if (delta.content === '' && !state.inThink && state.buffer === '') {
      out.push({ ...chunk, choices: [choice] })
      continue
    }
    const pieces = feedThink(delta.content, state)
    if (pieces.length === 0) {
      out.push({ ...chunk, choices: [{ ...choice, delta: { ...delta, content: '' } }] })
      continue
    }
    for (const [index, piece] of pieces.entries()) {
      const nextDelta = index === 0 ? { ...delta } : {}
      delete nextDelta.content
      delete nextDelta.reasoning_content
      nextDelta[piece.type === 'reasoning' ? 'reasoning_content' : 'content'] = piece.text
      out.push({
        ...chunk,
        choices: [{
          ...choice,
          delta: nextDelta,
          finish_reason: index === pieces.length - 1 ? choice.finish_reason : null,
        }],
      })
    }
  }
  return out
}

function sseEvent(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function transformSseEvent(raw, state, meta) {
  const data = raw
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (data === '') return `${raw}\n\n`
  if (data.trim() === '[DONE]') {
    const tail = flushThink(state)
    let output = ''
    for (const piece of tail) {
      output += sseEvent({
        id: meta.id ?? 'qwen-mode',
        object: 'chat.completion.chunk',
        created: meta.created ?? Math.floor(Date.now() / 1000),
        model: meta.model ?? '',
        choices: [{
          index: 0,
          delta: piece.type === 'reasoning' ? { reasoning_content: piece.text } : { content: piece.text },
          finish_reason: null,
        }],
      })
    }
    return `${output}data: [DONE]\n\n`
  }
  let parsed
  try {
    parsed = JSON.parse(data)
  } catch {
    return `${raw}\n\n`
  }
  if (parsed?.id !== undefined) meta.id = parsed.id
  if (parsed?.created !== undefined) meta.created = parsed.created
  if (parsed?.model !== undefined) meta.model = parsed.model
  return rewriteChunk(parsed, state).map(sseEvent).join('')
}

function writeProxyResponse(upstream, res, active, assumeReasoning) {
  const headers = { ...upstream.headers }
  delete headers['content-length']
  delete headers['transfer-encoding']
  headers['cache-control'] = 'no-store'
  res.writeHead(upstream.statusCode ?? 502, headers)
  res.flushHeaders()
  res.socket?.setNoDelay(true)
  const contentType = String(upstream.headers['content-type'] ?? '')
  if (!active || !contentType.includes('text/event-stream')) {
    if (!active || !contentType.includes('application/json')) {
      upstream.pipe(res)
      return
    }
    const chunks = []
    upstream.on('data', (chunk) => chunks.push(chunk))
    upstream.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (Array.isArray(payload.choices)) {
          const state = thinkState(assumeReasoning)
          payload.choices = payload.choices.map((choice) => ({
            ...choice,
            message: rewriteMessage(choice.message, state),
          }))
        }
        res.end(JSON.stringify(payload))
      } catch {
        res.end(Buffer.concat(chunks))
      }
    })
    return
  }
  const decoder = new StringDecoder('utf8')
  const state = thinkState(assumeReasoning)
  const meta = {}
  let buffer = ''
  upstream.on('data', (chunk) => {
    buffer += decoder.write(chunk)
    let index
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      res.write(transformSseEvent(raw, state, meta))
    }
  })
  upstream.on('end', () => {
    buffer += decoder.end()
    if (buffer.trim() !== '') res.write(transformSseEvent(buffer, state, meta))
    res.end()
  })
}

function forward(req, res, settings, logger, isActive, isVision) {
  let upstreamUrl
  try {
    const base = new URL(settings.upstream)
    const requestUrl = new URL(req.url ?? '/', 'http://qwen.invalid')
    const basePath = base.pathname.replace(/\/+$/u, '')
    upstreamUrl = new URL(`${basePath}${requestUrl.pathname}${requestUrl.search}`, base)
  } catch (error) {
    sendJson(res, 500, { ok: false, error: { message: `Invalid upstream URL: ${String(error)}` } })
    return
  }
  const transport = upstreamUrl.protocol === 'https:' ? https : http
  const headers = { ...req.headers, host: upstreamUrl.host, 'accept-encoding': 'identity' }
  delete headers['content-length']
  const bodyChunks = []
  req.on('data', (chunk) => bodyChunks.push(chunk))
  req.on('end', () => {
    let body = Buffer.concat(bodyChunks)
    let active = false
    let thinking = false
    if (settings.mode !== 'off' && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        active = isActive(parsed?.model)
        if (active) {
          thinking = thinkingEnabled(parsed, settings)
          body = Buffer.from(JSON.stringify(applyRequestDefaults(parsed, settings, isVision(parsed?.model))), 'utf8')
        }
      } catch {
        // Preserve non-JSON bodies unchanged.
      }
    }
    headers['content-length'] = String(body.length)
    const upstreamReq = transport.request(upstreamUrl, { method: req.method, headers }, (upstreamRes) => {
      writeProxyResponse(upstreamRes, res, active, thinking)
    })
    upstreamReq.setNoDelay(true)
    upstreamReq.on('error', (error) => {
      logger.warn(`[${SCOPE}] upstream request failed: ${String(error)}`)
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: { message: String(error) } })
      else res.destroy()
    })
    upstreamReq.end(body)
  })
  req.on('error', (error) => {
    logger.warn(`[${SCOPE}] proxy request failed: ${String(error)}`)
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: { message: String(error) } })
  })
}

function readProviderConfig(ctx) {
  const editor = ctx.configEditor
  const entry = editor.entries().find((candidate) => candidate.id === 'include:llm-pi-ai' || candidate.id?.endsWith(':llm-pi-ai'))
  if (entry === undefined) throw httpError(400, 'llm-pi-ai entry not found')
  const rows = editor.configuration()
  const row = rows.find((candidate) => candidate.entry === entry || candidate.entry?.id === entry.id)
  const config = { ...(row?.inherited ?? {}), ...(row?.override ?? {}) }
  const providers = config.providers !== null && typeof config.providers === 'object' ? config.providers : {}
  return { editor, entry, config, providers }
}

function shortName(id) {
  return id.split('/').pop().replace(/:[^:]+$/u, '') || id
}

function modelSpec(id, settings, vision = false) {
  const lower = id.toLowerCase()
  // GenieX exposes no reasoning-effort metadata; map known model families.
  const reasoningEfforts = lower.includes('3.6-35b-a3b')
    ? { off: null, max: 'enabled' }
    : lower.includes('3.8')
      ? { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' }
      : undefined
  const contextWindow = settings.contextWindow ?? (settings.protocol === 'qwen' ? DEFAULTS.contextWindow : null)
  const spec = {
    id,
    name: shortName(id),
    maxTokens: settings.maxOutputTokens,
    reasoningEfforts,
    input: vision ? ['text', 'image'] : ['text'],
  }
  if (contextWindow !== null) spec.contextWindow = contextWindow
  return spec
}

async function credentialHeader(ctx, settings) {
  const ref = apiKeyRef(settings)
  try {
    const key = (await ctx.credentials.resolve(ref))?.value ?? ''
    return key === '' ? {} : { authorization: `Bearer ${key}` }
  } catch {
    return {}
  }
}

async function modelSupportsVision(ctx, settings, id, headers) {
  const byName = /(?:^|[/_-])(?:vl|vision)(?:[/_-]|$)/iu.test(id)
  if (settings.protocol === 'geniex') {
    try {
      const detailUrl = upstreamURL(settings, 'models')
      detailUrl.pathname = `${detailUrl.pathname.replace(/\/+$/u, '')}/${id.split('/').map(encodeURIComponent).join('/')}`
      const response = await fetch(detailUrl, { headers, signal: AbortSignal.timeout(8000) })
      if (response.ok) {
        const detail = await response.json()
        if (typeof detail?.model_type === 'string') return detail.model_type.toLowerCase() === 'vlm'
      }
    } catch {
      // Fall back to the cache metadata or the model name.
    }
    try {
      const cacheRoot = await geniexCacheRoot()
      const parts = id.split('/')
      const owner = parts.shift() ?? 'local'
      const leaf = (parts.join('/') || owner).replace(/:[^:]+$/u, '')
      const meta = JSON.parse(await readFile(join(cacheRoot, owner, leaf, 'geniex.json'), 'utf8'))
      return meta?.ModelType === 'vlm' || meta?.MMProjFile?.Downloaded === true
    } catch {
      // Cache metadata is optional.
    }
  }
  return byName
}

async function discoverModels(ctx, settings) {
  const url = upstreamURL(settings, 'models')
  const headers = { accept: 'application/json', ...await credentialHeader(ctx, settings) }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw httpError(502, `model discovery failed: HTTP ${response.status}`)
  const body = await response.json()
  const rows = Array.isArray(body?.data) ? body.data : []
  const models = rows.map((row) => typeof row?.id === 'string' ? row.id : '').filter((id) => id !== '')
  if (models.length === 0) throw httpError(502, 'model discovery returned no models')
  return Promise.all(models.map(async (id) => modelSpec(id, settings, await modelSupportsVision(ctx, settings, id, headers))))
}

async function warmModel(ctx, settings, model) {
  const url = upstreamURL(settings, 'chat/completions')
  const body = {
    model,
    messages: [
      { role: 'system', content: `You are ${shortName(model)}, a helpful agent. This is the warming stage.` },
      { role: 'user', content: 'Hi' },
    ],
    max_completion_tokens: 1,
    temperature: 0,
    stream: false,
    ...settings.protocol === 'qwen'
      ? { enable_thinking: false }
      : { enable_think: false, reasoning_format: 'none' },
  }
  const startedAt = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...await credentialHeader(ctx, settings) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
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

async function ensureProvider(ctx, settings) {
  const { editor, entry } = readProviderConfig(ctx)
  const id = providerIdFor(settings.protocol)
  const keyRef = apiKeyRef(settings)
  if (keyRef === 'local') {
    await ctx.credentials.set('local', 'local')
  }
  const models = await discoverModels(ctx, settings)
  const desired = {
    displayName: providerNameFor(settings.protocol),
    api: 'openai-completions',
    baseURL: proxyBaseURL(settings),
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
  await editor.edit(entry, (current, inherited) => {
    const config = { ...(inherited ?? {}), ...(current ?? {}) }
    const providers = {
      ...((inherited ?? {}).providers ?? {}),
      ...((current ?? {}).providers ?? {}),
    }
    if (previous !== null) delete providers[previous]
    providers[id] = desired
    return { ...config, providers }
  })
  settings.managedProviderId = id
  settings.lastError = null
  try {
    ctx.emit('llm/models-updated', id)
  } catch {
    // Catalog refresh is best-effort; the provider config is already committed.
  }
  return {
    id,
    displayName: desired.displayName,
    baseURL: desired.baseURL,
    models: models.map((model) => model.id),
    visionModels: models.filter((model) => model.input.includes('image')).map((model) => model.id),
  }
}

async function removeProvider(ctx, settings) {
  if (settings.managedProviderId === null) return
  const { editor, entry } = readProviderConfig(ctx)
  const id = settings.managedProviderId
  await editor.edit(entry, (current, inherited) => {
    const config = { ...(inherited ?? {}), ...(current ?? {}) }
    const providers = {
      ...((inherited ?? {}).providers ?? {}),
      ...((current ?? {}).providers ?? {}),
    }
    delete providers[id]
    return { ...config, providers }
  })
  try {
    ctx.emit('llm/models-updated', id)
  } catch {
    // Catalog refresh is best-effort.
  }
  settings.managedProviderId = null
}

function providerStatus(ctx, settings) {
  try {
    const { providers } = readProviderConfig(ctx)
    const id = settings.managedProviderId
    const provider = id === null ? undefined : providers[id]
    return {
      error: null,
      provider: id === null ? null : {
        id,
        displayName: provider?.displayName ?? providerNameFor(settings.protocol),
        baseURL: provider?.baseURL ?? '',
        exists: provider !== undefined,
        models: Array.isArray(provider?.models) ? provider.models.map((model) => model.id) : [],
        visionModels: Array.isArray(provider?.models)
          ? provider.models.filter((model) => Array.isArray(model.input) && model.input.includes('image')).map((model) => model.id)
          : [],
      },
    }
  } catch (error) {
    return { error: String(error), provider: null }
  }
}

export async function apply(ctx) {
  const logger = loggerFor(ctx)
  const profileDir = text(process.env.DSH_PROFILE_DIR) || process.cwd()
  const storePath = join(profileDir, STORE_FILE)
  let settings = normalizeSettings({})
  try {
    settings = normalizeSettings(JSON.parse(await readFile(storePath, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn(`[${SCOPE}] cannot read settings: ${String(error)}`)
  }
  const persist = async () => {
    await mkdir(profileDir, { recursive: true })
    await writeFile(storePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  }
  await persist().catch((error) => logger.warn(`[${SCOPE}] cannot save settings: ${String(error)}`))

  const managedModels = new Set()
  const visionModels = new Set()
  const refreshManagedModels = () => {
    managedModels.clear()
    visionModels.clear()
    try {
      const provider = providerStatus(ctx, settings).provider
      for (const id of provider?.models ?? []) managedModels.add(id)
      for (const id of provider?.visionModels ?? []) visionModels.add(id)
    } catch {
      // The provider is maintained lazily when the settings page saves.
    }
  }
  refreshManagedModels()
  const isActive = (model) => {
    if (settings.mode !== 'auto') return false
    return typeof model === 'string' && managedModels.has(model)
  }
  const turnMetrics = new Map()
  const stepStarts = new Map()
  const firstTokens = new Map()
  const derivedSessions = new Set()
  const trimMap = (map, max) => {
    while (map.size > max) {
      const oldest = map.keys().next().value
      if (oldest === undefined) return
      map.delete(oldest)
    }
  }
  const deriveSessionMetrics = (session) => {
    if (derivedSessions.has(session.id)) return
    let events
    try {
      events = session.snapshotEvents()
    } catch {
      return
    }
    const starts = new Map()
    const firsts = new Map()
    for (const event of events) {
      const turn = event.data?.turn
      const step = event.data?.step
      if (!Number.isInteger(turn) || !Number.isInteger(step)) continue
      const key = `${turn}:${step}`
      if (event.type === 'step/start') {
        starts.set(key, event.time)
      } else if (event.type === 'assistant/attempt') {
        const first = streamFirstTokenTime(event.data.stream)
        if (first !== undefined) firsts.set(key, first)
      } else if (event.type === 'assistant/message') {
        const first = firsts.get(key) ?? streamFirstTokenTime(event.data.stream) ?? event.time
        const metric = turnMetric(event, first, starts.get(key) ?? first)
        if (metric !== null) turnMetrics.set(`${session.id}:${turn}`, metric)
      }
    }
    derivedSessions.add(session.id)
    trimMap(turnMetrics, 2000)
    while (derivedSessions.size > 200) {
      const oldest = derivedSessions.values().next().value
      if (oldest === undefined) break
      derivedSessions.delete(oldest)
    }
  }
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const turn = event.data?.turn
    const step = event.data?.step
    if (!Number.isInteger(turn) || !Number.isInteger(step)) return
    const key = `${session.id}:${turn}:${step}`
    if (event.type === 'step/start') {
      stepStarts.set(key, event.time)
      trimMap(stepStarts, 2000)
      return
    }
    if (event.type === 'assistant/attempt') {
      const first = streamFirstTokenTime(event.data.stream)
      if (first !== undefined) firstTokens.set(key, first)
      trimMap(firstTokens, 2000)
      return
    }
    if (event.type !== 'assistant/message') return
    const first = firstTokens.get(key) ?? streamFirstTokenTime(event.data.stream) ?? event.time
    const start = stepStarts.get(key) ?? first
    stepStarts.delete(key)
    firstTokens.delete(key)
    const metric = turnMetric(event, first, start)
    if (metric === null) return
    turnMetrics.set(`${session.id}:${turn}`, metric)
    trimMap(turnMetrics, 2000)
  }), `${SCOPE}: turn metrics`)

  const state = () => ({
    ...settings,
    proxyBaseURL: proxyBaseURL(settings),
    ...providerStatus(ctx, settings),
  })

  const syncProvider = async () => {
    if (settings.mode === 'off') {
      await removeProvider(ctx, settings)
      managedModels.clear()
      visionModels.clear()
      return
    }
    const provider = await ensureProvider(ctx, settings)
    managedModels.clear()
    visionModels.clear()
    for (const id of provider.models) managedModels.add(id)
    for (const id of provider.visionModels) visionModels.add(id)
  }

  const api = {
    state: () => state(),
    setMode: async (payload) => {
      const mode = ['off', 'auto'].includes(payload?.mode) ? payload.mode : null
      if (mode === null) throw httpError(400, 'invalid mode')
      if (mode === settings.mode) return state()
      const previous = settings.mode
      settings.mode = mode
      try {
        await syncProvider()
        settings.lastError = null
      } catch (error) {
        settings.mode = previous
        settings.lastError = String(error)
        await persist()
        throw httpError(500, String(error))
      }
      await persist()
      return state()
    },
    turnStats: (payload) => {
      const sessionId = text(payload?.sessionId)
      const turn = Number(payload?.turn)
      if (sessionId === '' || !Number.isInteger(turn)) return null
      const key = `${sessionId}:${turn}`
      const cached = turnMetrics.get(key)
      if (cached !== undefined) return cached
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) return null
      deriveSessionMetrics(session)
      return turnMetrics.get(key) ?? null
    },
    permissionLabel: async (payload) => {
      const locale = text(payload?.locale)
      const name = locale === 'en' ? 'Reply Only' : '仅回复'
      const entry = ctx.configEditor.entries().find((candidate) => {
        return candidate.options.id === 'permission' || candidate.options.id?.endsWith(':permission')
      })
      if (entry === undefined) return { updated: false, name }
      await ctx.configEditor.edit(entry, (current, inherited) => {
        const config = { ...(inherited ?? {}), ...(current ?? {}) }
        const presets = {
          'read-only': { sandbox: 'read-only', approval: 'ask' },
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
          ...((inherited ?? {}).presets ?? {}),
          ...((current ?? {}).presets ?? {}),
        }
        const reply = presets['reply-only'] ?? {
          sandbox: 'read-only',
          approval: 'never',
          description: '禁止工具调用，仅进行纯文本对话。',
        }
        if (presets['reply-only']?.name === name && Object.keys(presets)[0] === 'reply-only') return config
        const next = { 'reply-only': { ...reply, name, description: '禁止工具调用，仅进行纯文本对话。 ' } }
        for (const [key, value] of Object.entries(presets)) {
          if (key !== 'reply-only') next[key] = value
        }
        return { ...config, presets: next }
      })
      return { updated: true, name }
    },
    warm: async (payload) => {
      if (!settings.warm) throw httpError(409, 'model warmup is disabled')
      const model = text(payload?.model)
      if (model === '' || !managedModels.has(model)) throw httpError(400, 'unknown managed model')
      const result = await warmModel(ctx, settings, model)
      return { warmed: true, model, ...result }
    },
    save: async (payload) => {
      const mode = ['off', 'auto', 'always'].includes(payload?.mode) ? payload.mode : settings.mode
      const next = normalizeSettings({ ...settings, ...payload, mode })
      settings = next
      try {
        await syncProvider()
        settings.lastError = null
      } catch (error) {
        settings.lastError = String(error)
      }
      await persist()
      return state()
    },
    apply: async () => {
      try {
        const provider = await ensureProvider(ctx, settings)
        managedModels.clear()
        visionModels.clear()
        for (const id of provider.models) managedModels.add(id)
        for (const id of provider.visionModels) visionModels.add(id)
        settings.lastError = null
      } catch (error) {
        settings.lastError = String(error)
      }
      await persist()
      return state()
    },
    remove: async () => {
      try {
        await removeProvider(ctx, settings)
        managedModels.clear()
        visionModels.clear()
        settings.lastError = null
      } catch (error) {
        settings.lastError = String(error)
      }
      await persist()
      return state()
    },
  }

  ctx.effect(() => ctx.webServer.register({
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
        const payload = await readJson(req)
        sendJson(res, 200, { ok: true, value: await api[method](payload) })
      } catch (error) {
        sendJson(res, error?.status ?? 500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
      }
    },
  }), `${SCOPE}: settings API`)

  ctx.effect(() => ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    const session = ctx.sessions.get(agent.id)
    if (session === undefined) return undefined
    try {
      return ctx.permissionPresets.current(session) === 'reply-only'
        ? 'Reply-only mode: tool calls are disabled'
        : undefined
    } catch {
      return undefined
    }
  }), `${SCOPE}: reply-only tool guard`)

  const replyRestrictions = new Map()
  const applyReplyOnly = (agent) => {
    const session = ctx.sessions.get(agent.id)
    if (session === undefined) return
    let reply = false
    try {
      reply = ctx.permissionPresets.current(session) === 'reply-only'
    } catch {
      return
    }
    const active = replyRestrictions.get(agent.id)
    if (!reply) {
      if (active !== undefined) {
        active()
        replyRestrictions.delete(agent.id)
      }
      return
    }
    if (active !== undefined) return
    try {
      const scoped = agent.ctx
      if (scoped?.tools?.restrict !== undefined) {
        replyRestrictions.set(agent.id, scoped.tools.restrict({ allow: [] }))
      }
    } catch (error) {
      logger.warn(`[${SCOPE}] cannot hide tools for reply-only session: ${String(error)}`)
    }
  }

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => applyReplyOnly(agent)), `${SCOPE}: reply-only agent setup`)
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type !== 'permission/preset' && event.type !== 'sandbox/mode' && event.type !== 'approval/policy') return
    queueMicrotask(() => {
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) applyReplyOnly(agent)
    })
  }), `${SCOPE}: reply-only permission changes`)
  ctx.effect(() => () => {
    for (const dispose of replyRestrictions.values()) dispose()
    replyRestrictions.clear()
  }, `${SCOPE}: reply-only restrictions`)
  for (const agent of ctx.agents.list()) applyReplyOnly(agent)
  try {
    ctx.emit('permission-presets/catalog-changed')
  } catch {
    // The permission catalog refresh is best-effort.
  }

  const server = http.createServer((req, res) => forward(req, res, settings, logger, isActive, (model) => visionModels.has(model)))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(settings.proxyPort, '127.0.0.1', resolve)
  })
  ctx.effect(() => () => new Promise((resolve) => server.close(() => resolve())), `${SCOPE}: proxy server`)

  const labelTimer = setTimeout(() => {
    void api.permissionLabel({ locale: 'zh' }).catch((error) => {
      logger.warn(`[${SCOPE}] cannot ensure reply-only permission preset: ${String(error)}`)
    })
  }, 1500)
  ctx.effect(() => () => clearTimeout(labelTimer), `${SCOPE}: permission preset bootstrap`)
}




