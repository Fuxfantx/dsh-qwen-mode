/**
 * Host half of the Qwen mode bundle.
 *
 * Starts a loopback OpenAI-compatible proxy and maintains dedicated
 * `llm-pi-ai` providers (`From GenieX`, `From QwenCloud`, ...) that point at
 * it. The proxy normalizes thinking parameters and passes through or rebuilds
 * `reasoning_content` from tagged or inline reasoning.
 *
 * @module dsh-qwen-mode
 */

import { execFile } from 'node:child_process'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const SCOPE = 'qwen-mode'
const API_PREFIX = '/qwen-mode/api'
const STORE_FILE = 'qwen-mode.json'
const MAX_BODY = 8 * 1024 * 1024
const MAX_PROXY_BODY = 32 * 1024 * 1024
const DEFAULT_PORT = 18182
const MTP_SPEC_TYPE = 'draft-mtp'
const MTP_DRAFT_TOKENS = 3
const VIT_COMPUTE_VALUE = { cpu: 'CPU', gpu: 'GPU', npu: 'HTP2' }
const VISION_MODEL_PATTERN = /(?:^|[/_-])(?:vl|vision)(?:[/_-]|$)/iu
const KNOWN_REASONING_EFFORTS = [
  { match: '3.6-35b-a3b', efforts: { off: null, max: 'enabled' } },
  { match: '3.8', efforts: { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' } },
]
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000
const CAPABILITY_CACHE_LIMIT = 512
const GGUF_PREFIX_BYTES = 32 * 1024 * 1024
const reasoningEffortCache = new Map()
const visionCache = new Map()
const modelMetadataCache = new Map()

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
  autoNctx: false,
  mtp: false,
  compute: '',
  vitCompute: 'npu',
  temperature: null,
  topP: null,
  topK: null,
  minP: null,
  repetitionPenalty: null,
  presencePenalty: null,
  frequencyPenalty: null,
}

/** Services required by the proxy, provider maintenance, and settings API. */
export const inject = ['webServer', 'connection', 'configEditor', 'credentials', 'permissionPresets', 'sessions', 'agents', 'tools']

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeUpstream(value) {
  const candidate = text(value).replace(/\/+$/u, '')
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : DEFAULTS.upstream
  } catch {
    return DEFAULTS.upstream
  }
}

function assertUpstream(value) {
  const candidate = text(value)
  try {
    const url = new URL(candidate)
    if (url.protocol === 'http:' || url.protocol === 'https:') return
  } catch {}
  throw httpError(400, 'Upstream URL must be an absolute http(s) URL')
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
function buildTurnMetric(event, first, start) {
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
    let rejected = false
    const chunks = []
    req.on('data', (chunk) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_BODY) {
        rejected = true
        chunks.length = 0
        reject(httpError(413, 'request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
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
    req.on('aborted', () => reject(httpError(400, 'request aborted')))
  })
}

function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const port = typeof source.proxyPort === 'number' && Number.isInteger(source.proxyPort) && source.proxyPort > 0 && source.proxyPort < 65536
    ? source.proxyPort
    : DEFAULT_PORT
  const protocol = source.protocol === 'qwen' ? 'qwen' : 'geniex'
  const contextWindow = positiveIntOrNull(source.contextWindow)
  const autoNctx = source.autoNctx === true
  const effectiveContext = contextWindow ?? (protocol === 'qwen' ? DEFAULTS.contextWindow : null)
  const maxOutput = positiveInt(source.maxOutputTokens, DEFAULTS.maxOutputTokens)
  return {
    version: 1,
    mode: ['off', 'auto'].includes(source.mode)
      ? source.mode
      : source.enabled === true || source.mode === 'always' ? 'auto' : 'off',
    warm: source.warm === true,
    protocol,
    upstream: normalizeUpstream(source.upstream),
    apiKeyEnv: text(source.apiKeyEnv),
    proxyPort: port,
    managedProviderId: text(source.managedProviderId) || null,
    contextWindow,
    maxOutputTokens: autoNctx ? maxOutput : effectiveContext === null ? maxOutput : Math.min(maxOutput, effectiveContext),
    autoNctx,
    mtp: source.mtp === true,
    compute: text(source.compute).slice(0, 100),
    vitCompute: ['cpu', 'gpu', 'npu'].includes(source.vitCompute) ? source.vitCompute : DEFAULTS.vitCompute,
    temperature: numberOrNull(source.temperature),
    topP: numberOrNull(source.topP),
    topK: numberOrNull(source.topK),
    minP: numberOrNull(source.minP),
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

function upstreamRequestURL(settings, requestUrl) {
  const base = new URL(settings.upstream)
  const basePath = base.pathname.replace(/\/+$/u, '')
  let requestPath = requestUrl.pathname
  if (basePath.endsWith('/v1') && (requestPath === '/v1' || requestPath.startsWith('/v1/'))) {
    requestPath = requestPath.slice(3) || '/'
  }
  return new URL(`${basePath}${requestPath}${requestUrl.search}`, base)
}

let geniexModelsRootPromise = null
function geniexModelsRoot() {
  if (geniexModelsRootPromise !== null) return geniexModelsRootPromise
  geniexModelsRootPromise = new Promise((resolveRoot) => {
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
  return geniexModelsRootPromise
}

const GGUF_SCALAR_SIZE = new Map([
  [0, 1], [1, 1], [2, 2], [3, 2], [4, 4], [5, 4], [6, 4], [7, 1], [10, 8], [11, 8], [12, 8],
])
const GGUF_SAMPLING_KEYS = {
  'general.sampling.temp': 'temperature',
  'general.sampling.temperature': 'temperature',
  'general.sampling.top_k': 'topK',
  'general.sampling.top_p': 'topP',
  'general.sampling.min_p': 'minP',
  'general.sampling.presence_penalty': 'presencePenalty',
  'general.sampling.frequency_penalty': 'frequencyPenalty',
  'general.sampling.repetition_penalty': 'repetitionPenalty',
}

function parseGgufPrefix(buffer) {
  let offset = 0
  const remaining = () => buffer.length - offset
  const need = (size) => {
    if (remaining() < size) throw new Error('truncated GGUF header')
  }
  const u32 = () => {
    need(4)
    const value = buffer.readUInt32LE(offset)
    offset += 4
    return value
  }
  const u64 = () => {
    need(8)
    const value = Number(buffer.readBigUInt64LE(offset))
    offset += 8
    return value
  }
  const string = () => {
    const length = u64()
    if (length > remaining()) throw new Error('truncated GGUF string')
    const value = buffer.toString('utf8', offset, offset + length)
    offset += length
    return value
  }
  const skipString = () => {
    const length = u64()
    if (length > remaining()) throw new Error('truncated GGUF string')
    offset += length
  }
  const skipValue = (type, depth = 0) => {
    if (depth > 8) throw new Error('GGUF nesting too deep')
    if (GGUF_SCALAR_SIZE.has(type)) {
      const size = GGUF_SCALAR_SIZE.get(type)
      need(size)
      offset += size
      return
    }
    if (type === 8) {
      skipString()
      return
    }
    if (type !== 9) throw new Error(`unsupported GGUF type ${type}`)
    const inner = u32()
    const count = u64()
    for (let index = 0; index < count; index += 1) skipValue(inner, depth + 1)
  }
  const readScalar = (type) => {
    if (type === 0) { need(1); return buffer.readUInt8(offset++) }
    if (type === 1) { need(1); return buffer.readInt8(offset++) }
    if (type === 2) { need(2); const v = buffer.readUInt16LE(offset); offset += 2; return v }
    if (type === 3) { need(2); const v = buffer.readInt16LE(offset); offset += 2; return v }
    if (type === 4) return u32()
    if (type === 5) { need(4); const v = buffer.readInt32LE(offset); offset += 4; return v }
    if (type === 6) { need(4); const v = buffer.readFloatLE(offset); offset += 4; return v }
    if (type === 7) { need(1); return buffer.readUInt8(offset++) !== 0 }
    if (type === 10) return u64()
    if (type === 11) { need(8); const v = Number(buffer.readBigInt64LE(offset)); offset += 8; return v }
    if (type === 12) { need(8); const v = buffer.readDoubleLE(offset); offset += 8; return v }
    throw new Error(`unsupported GGUF scalar ${type}`)
  }
  const readStringArray = (count) => {
    const values = []
    for (let index = 0; index < count; index += 1) values.push(string())
    return values
  }

  need(4)
  if (buffer.toString('ascii', 0, 4) !== 'GGUF') throw new Error('not a GGUF file')
  offset = 4
  const version = u32()
  const tensorCount = u64()
  const kvCount = u64()
  const meta = {}
  for (let index = 0; index < kvCount; index += 1) {
    const key = string()
    const type = u32()
    if (type === 8) {
      if (key === 'general.name' || key === 'general.finetune' || key === 'general.basename' || key === 'general.architecture') {
        meta[key] = string()
      } else {
        skipString()
      }
    } else if (type === 9) {
      const inner = u32()
      const count = u64()
      if (key === 'general.tags' && inner === 8) meta[key] = readStringArray(count)
      else for (let item = 0; item < count; item += 1) skipValue(inner)
    } else {
      meta[key] = readScalar(type)
    }
  }
  let hasMtp = Object.entries(meta).some(([key, value]) => {
    return /nextn_predict_layers|mtp/i.test(key) && typeof value === 'number' && value > 0
  })
  for (let index = 0; index < tensorCount; index += 1) {
    const name = string()
    if (/nextn|mtp|draft_head/i.test(name)) hasMtp = true
    const dimensions = u32()
    need(dimensions * 8 + 12)
    offset += dimensions * 8 + 12
  }
  const contextKey = Object.keys(meta).find((key) => key.endsWith('.context_length'))
  const contextLength = contextKey === undefined ? null : positiveIntOrNull(meta[contextKey])
  const tags = Array.isArray(meta['general.tags']) ? meta['general.tags'].map((tag) => String(tag).toLowerCase()) : []
  const abliterated = tags.some((tag) => tag.includes('abliterat') || tag.includes('uncensored') || tag.includes('refusal-direction'))
  const sampling = {}
  for (const [key, name] of Object.entries(GGUF_SAMPLING_KEYS)) {
    if (typeof meta[key] === 'number' && Number.isFinite(meta[key])) sampling[name] = meta[key]
  }
  return {
    version,
    tensorCount,
    architecture: typeof meta['general.architecture'] === 'string' ? meta['general.architecture'] : '',
    name: typeof meta['general.name'] === 'string' ? meta['general.name'] : '',
    finetune: typeof meta['general.finetune'] === 'string' ? meta['general.finetune'] : '',
    contextLength,
    hasMtp,
    tags,
    abliterated,
    sampling,
  }
}

async function readModelMetadata(settings, id) {
  if (settings.protocol !== 'geniex') return null
  const cacheKey = `${settings.upstream}|${id}`
  const cached = modelMetadataCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < CAPABILITY_CACHE_TTL_MS) return cached.value
  let value = null
  try {
    const cacheRoot = await geniexModelsRoot()
    const { owner, leaf, precision } = splitModelId(id)
    const manifest = JSON.parse(await readFile(join(cacheRoot, owner, leaf, 'geniex.json'), 'utf8'))
    const file = manifest?.ModelFile?.[precision]?.Name
      ?? Object.values(manifest?.ModelFile ?? {}).find((entry) => entry?.Downloaded === true)?.Name
    if (typeof file === 'string' && file !== '') {
      const path = join(cacheRoot, owner, leaf, file)
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.allocUnsafe(GGUF_PREFIX_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        value = {
          ...parseGgufPrefix(buffer.subarray(0, bytesRead)),
          pluginId: typeof manifest?.PluginId === 'string' ? manifest.PluginId : '',
        }
      } finally {
        await handle.close()
      }
    }
  } catch {
    // A missing or partial cache entry simply disables the optional model metadata.
  }
  modelMetadataCache.set(cacheKey, { value, at: Date.now() })
  if (modelMetadataCache.size > CAPABILITY_CACHE_LIMIT) {
    modelMetadataCache.delete(modelMetadataCache.keys().next().value)
  }
  return value
}

function thinkingEnabled(body) {
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim().toLowerCase() : null
  if (effort !== null && effort !== '') return !['off', 'none'].includes(effort)
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

function loadFields(settings, context, mtp) {
  const fields = {}
  if (settings.protocol === 'geniex') {
    if (typeof context === 'number' && context > 0) fields.nctx = context
    if (mtp) {
      fields.spec_type = MTP_SPEC_TYPE
      fields.spec_n_max = MTP_DRAFT_TOKENS
      fields.spec_n_min = 0
      fields.spec_p_min = 0
    }
  }
  return fields
}

function applyRequestDefaults(body, settings, vision = false, context = null, mtp = false) {
  const output = { ...body }
  const thinking = thinkingEnabled(body)
  if (settings.protocol === 'qwen') {
    output.enable_thinking = thinking
    output.preserve_thinking = true
    delete output.enable_think
  } else {
    output.enable_think = thinking
    delete output.enable_thinking
    const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim().toLowerCase() : ''
    if (thinking && ['low', 'medium', 'high', 'xhigh'].includes(effort)) output.reasoning_effort = effort
    else delete output.reasoning_effort
    output.reasoning_format = 'auto'
    Object.assign(output, inferenceFields(settings, vision))
  }
  for (const key of Object.keys(output)) {
    if (key.startsWith('spec_')) delete output[key]
  }
  if (settings.protocol === 'geniex') delete output.nctx
  Object.assign(output, loadFields(settings, context, mtp))
  const fill = (key, value) => {
    if (value !== null && output[key] === undefined) output[key] = value
  }
  fill('temperature', settings.temperature)
  fill('top_p', settings.topP)
  fill('top_k', settings.topK)
  fill('min_p', settings.minP)
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

function createThinkState(assumeReasoning = false) {
  return { buffer: '', inThink: false, assumeReasoning, separated: false, pending: false, serverSeparated: false }
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

function feedReasoning(value, state) {
  if (state.serverSeparated) {
    const out = []
    pushPiece(out, 'content', value)
    return out
  }
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

function flushReasoning(state) {
  const out = []
  if (state.buffer !== '') {
    if (state.serverSeparated) {
      pushPiece(out, 'content', state.buffer)
      state.buffer = ''
      return out
    }
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
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim() !== '') return message
  const pieces = [...feedReasoning(message.content, state), ...flushReasoning(state)]
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
    if (delta === null || typeof delta !== 'object') {
      out.push({ ...chunk, choices: [choice] })
      continue
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      state.serverSeparated = true
      out.push({ ...chunk, choices: [choice] })
      continue
    }
    if (state.serverSeparated) {
      out.push({ ...chunk, choices: [choice] })
      continue
    }
    if (typeof delta.content !== 'string') {
      out.push({ ...chunk, choices: [choice] })
      continue
    }
    if (delta.content === '' && !state.inThink && state.buffer === '') {
      out.push({ ...chunk, choices: [choice] })
      continue
    }
    const pieces = feedReasoning(delta.content, state)
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
    const tail = flushReasoning(state)
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
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']) {
    delete headers[name]
  }
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
          payload.choices = payload.choices.map((choice) => ({
            ...choice,
            message: rewriteMessage(choice.message, createThinkState(assumeReasoning)),
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
  const state = createThinkState(assumeReasoning)
  const meta = {}
  let buffer = ''
  upstream.on('data', (chunk) => {
    buffer += decoder.write(chunk)
    let index = -1
    let width = 2
    while (true) {
      const lf = buffer.indexOf('\n\n')
      const crlf = buffer.indexOf('\r\n\r\n')
      if (crlf !== -1 && (lf === -1 || crlf < lf)) {
        index = crlf
        width = 4
      } else if (lf !== -1) {
        index = lf
        width = 2
      } else {
        break
      }
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + width)
      res.write(transformSseEvent(raw, state, meta))
    }
  })
  upstream.on('end', () => {
    buffer += decoder.end()
    if (buffer.trim() !== '') res.write(transformSseEvent(buffer, state, meta))
    res.end()
  })
}

function forward(req, res, settings, logger, ownsModel, isVision, modelContext, useMtp) {
  let upstreamUrl
  try {
    const requestUrl = new URL(req.url ?? '/', 'http://qwen.invalid')
    upstreamUrl = upstreamRequestURL(settings, requestUrl)
  } catch (error) {
    sendJson(res, 500, { ok: false, error: { message: `Invalid upstream URL: ${String(error)}` } })
    return
  }
  const transport = upstreamUrl.protocol === 'https:' ? https : http
  const headers = { ...req.headers, host: upstreamUrl.host, 'accept-encoding': 'identity' }
  delete headers['content-length']
  delete headers['transfer-encoding']
  const bodyChunks = []
  let bodySize = 0
  let rejected = false
  let upstreamReq = null
  req.on('data', (chunk) => {
    if (rejected) return
    bodySize += chunk.length
    if (bodySize > MAX_PROXY_BODY) {
      rejected = true
      bodyChunks.length = 0
      sendJson(res, 413, { ok: false, error: { message: 'request body is too large' } })
      req.resume()
      return
    }
    bodyChunks.push(chunk)
  })
  req.on('end', () => {
    if (rejected) return
    let body = Buffer.concat(bodyChunks)
    let active = false
    let thinking = false
    if (settings.mode !== 'off' && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        active = ownsModel(parsed?.model)
        if (active) {
          thinking = thinkingEnabled(parsed, settings)
          body = Buffer.from(JSON.stringify(applyRequestDefaults(
            parsed,
            settings,
            isVision(parsed?.model),
            modelContext(parsed?.model),
            useMtp(parsed?.model),
          )), 'utf8')
        }
      } catch {
        // Preserve non-JSON bodies unchanged.
      }
    }
    headers['content-length'] = String(body.length)
    try {
      upstreamReq = transport.request(upstreamUrl, { method: req.method, headers }, (upstreamRes) => {
        writeProxyResponse(upstreamRes, res, active, thinking)
      })
    } catch (error) {
      logger.warn(`[${SCOPE}] cannot create upstream request: ${String(error)}`)
      sendJson(res, 502, { ok: false, error: { message: String(error) } })
      return
    }
    upstreamReq.setNoDelay(true)
    upstreamReq.on('error', (error) => {
      logger.warn(`[${SCOPE}] upstream request failed: ${String(error)}`)
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: { message: String(error) } })
      else res.destroy()
    })
    upstreamReq.end(body)
  })
  req.on('error', (error) => {
    upstreamReq?.destroy()
    logger.warn(`[${SCOPE}] proxy request failed: ${String(error)}`)
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: { message: String(error) } })
  })
  req.on('aborted', () => {
    rejected = true
    upstreamReq?.destroy()
  })
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq?.destroy()
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

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await operation(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function splitModelId(id) {
  const parts = id.split('/')
  const owner = parts.shift() ?? 'local'
  const leaf = (parts.join('/') || owner).replace(/:[^:]+$/u, '')
  const colon = id.lastIndexOf(':')
  return { owner, leaf, precision: colon === -1 ? '' : id.slice(colon + 1) }
}

function buildModelSpec(id, settings, vision = false, reasoningEfforts, metadata = null) {
  const known = KNOWN_REASONING_EFFORTS.find((entry) => id.toLowerCase().includes(entry.match))?.efforts
  const metadataContext = positiveIntOrNull(metadata?.contextLength)
  const contextWindow = settings.autoNctx
    ? metadataContext ?? settings.contextWindow
    : settings.contextWindow ?? (settings.protocol === 'qwen' ? DEFAULTS.contextWindow : null)
  const model = {
    id,
    name: shortName(id),
    maxTokens: contextWindow === null ? settings.maxOutputTokens : Math.min(settings.maxOutputTokens, contextWindow),
    reasoningEfforts: reasoningEfforts ?? known,
    input: vision ? ['text', 'image'] : ['text'],
  }
  if (contextWindow !== null) model.contextWindow = contextWindow
  return model
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

async function detectReasoningEfforts(settings, id) {
  if (settings.protocol !== 'geniex') return undefined
  const cacheKey = `${settings.upstream}|${id}`
  const cached = reasoningEffortCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < CAPABILITY_CACHE_TTL_MS) return cached.value
  let result
  try {
    const cacheRoot = await geniexModelsRoot()
    const { owner, leaf, precision } = splitModelId(id)
    const meta = JSON.parse(await readFile(join(cacheRoot, owner, leaf, 'geniex.json'), 'utf8'))
    const file = meta?.ModelFile?.[precision]?.Name
      ?? Object.values(meta?.ModelFile ?? {}).find((entry) => entry?.Downloaded === true)?.Name
    if (typeof file === 'string' && file !== '') {
      const handle = await open(join(cacheRoot, owner, leaf, file), 'r')
      try {
        const buffer = Buffer.alloc(4 * 1024 * 1024)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        const start = text.indexOf('tokenizer.chat_template')
        const template = start === -1 ? '' : text.slice(start, start + 200000)
        if (template.includes('reasoning_effort')) {
          const levels = new Set()
          for (const match of template.matchAll(/['"](low|medium|high|xhigh)['"]/gu)) levels.add(match[1])
          if (levels.size > 0) {
            result = { off: null }
            for (const level of levels) result[level] = level
          }
        } else if (template.includes('enable_thinking')) {
          result = { off: null, max: 'enabled' }
        }
      } finally {
        await handle.close()
      }
    }
  } catch {
    // The cache is optional; known model families still provide a fallback.
  }
  reasoningEffortCache.set(cacheKey, { value: result, at: Date.now() })
  if (reasoningEffortCache.size > CAPABILITY_CACHE_LIMIT) reasoningEffortCache.delete(reasoningEffortCache.keys().next().value)
  return result
}

async function detectVision(settings, id, headers) {
  const cacheKey = `${settings.protocol}|${settings.upstream}|${id}`
  const cached = visionCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < CAPABILITY_CACHE_TTL_MS) return cached.value
  const value = await detectVisionUncached(settings, id, headers)
  visionCache.set(cacheKey, { value, at: Date.now() })
  if (visionCache.size > CAPABILITY_CACHE_LIMIT) visionCache.delete(visionCache.keys().next().value)
  return value
}

async function detectVisionUncached(settings, id, headers) {
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
      const cacheRoot = await geniexModelsRoot()
      const { owner, leaf } = splitModelId(id)
      const meta = JSON.parse(await readFile(join(cacheRoot, owner, leaf, 'geniex.json'), 'utf8'))
      return meta?.ModelType === 'vlm' || meta?.MMProjFile?.Downloaded === true
    } catch {
      // Cache metadata is optional.
    }
  }
  return VISION_MODEL_PATTERN.test(id)
}

async function discoverModels(ctx, settings) {
  const url = upstreamURL(settings, 'models')
  const headers = { accept: 'application/json', ...await credentialHeader(ctx, settings) }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw httpError(502, `model discovery failed: HTTP ${response.status}`)
  const body = await response.json()
  const rows = Array.isArray(body?.data) ? body.data : []
  const unique = new Map()
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : ''
    if (id === '') continue
    const modelType = typeof row?.model_type === 'string' ? row.model_type : null
    const previous = unique.get(id)
    if (previous === undefined || (previous.modelType === null && modelType !== null)) {
      unique.set(id, { id, modelType })
    }
  }
  if (unique.size === 0) throw httpError(502, 'model discovery returned no models')
  const discovered = await mapLimit([...unique.values()], 6, async ({ id, modelType }) => {
    const known = KNOWN_REASONING_EFFORTS.find((entry) => id.toLowerCase().includes(entry.match))
    const [vision, reasoningEfforts, metadata] = await Promise.all([
      modelType !== null
        ? Promise.resolve(modelType.toLowerCase() === 'vlm')
        : detectVision(settings, id, headers),
      known === undefined ? detectReasoningEfforts(settings, id) : Promise.resolve(known.efforts),
      readModelMetadata(settings, id),
    ])
    return {
      spec: buildModelSpec(id, settings, vision, reasoningEfforts, metadata),
      metadata,
    }
  })
  return {
    models: discovered.map((entry) => entry.spec),
    capabilities: new Map(discovered.map((entry) => [entry.spec.id, entry.metadata])),
  }
}

async function warmUpModel(ctx, settings, model, vision = false, context = null, mtp = false) {
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
  }
  if (settings.protocol === 'qwen') body.enable_thinking = false
  else Object.assign(body, { enable_think: false, reasoning_format: 'none' }, inferenceFields(settings, vision), loadFields(settings, context, mtp))
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

async function upsertProvider(ctx, settings) {
  const { editor, entry } = readProviderConfig(ctx)
  const id = providerIdFor(settings.protocol)
  const keyRef = apiKeyRef(settings)
  if (keyRef === 'local') {
    try {
      await ctx.credentials.resolve('local')
    } catch {
      await ctx.credentials.set('local', 'local')
    }
  }
  const { models, capabilities } = await discoverModels(ctx, settings)
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
    capabilities,
  }
}

async function deleteProvider(ctx, settings) {
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
        models: Array.isArray(provider?.models) ? provider.models.map((model) => model.id) : [],
        visionModels: Array.isArray(provider?.models)
          ? provider.models.filter((model) => Array.isArray(model.input) && model.input.includes('image')).map((model) => model.id)
          : [],
      },
    }
  } catch {
    return { provider: null }
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
    const body = `${JSON.stringify(settings, null, 2)}\n`
    const temporary = `${storePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, body, 'utf8')
    try {
      await rename(temporary, storePath)
    } catch {
      await writeFile(storePath, body, 'utf8')
      try {
        await unlink(temporary)
      } catch {
        // A leftover temporary file is harmless.
      }
    }
  }
  await persist().catch((error) => logger.warn(`[${SCOPE}] cannot save settings: ${String(error)}`))

  const managedModels = new Set()
  const visionModels = new Set()
  const mtpModels = new Set()
  const modelContexts = new Map()
  const modelCapabilities = new Map()
  let modelRevision = 0
  const applyCapabilities = (capabilities = new Map()) => {
    mtpModels.clear()
    modelContexts.clear()
    modelCapabilities.clear()
    for (const [id, metadata] of capabilities) {
      modelCapabilities.set(id, metadata)
      if (metadata?.hasMtp === true && metadata.pluginId === 'llama_cpp') mtpModels.add(id)
      if (typeof metadata?.contextLength === 'number') modelContexts.set(id, metadata.contextLength)
    }
  }
  const refreshManagedModels = async () => {
    managedModels.clear()
    visionModels.clear()
    mtpModels.clear()
    modelContexts.clear()
    modelCapabilities.clear()
    const provider = readManagedProvider(ctx, settings).provider
    for (const id of provider?.models ?? []) managedModels.add(id)
    for (const id of provider?.visionModels ?? []) visionModels.add(id)
    const entries = await mapLimit([...managedModels], 4, async (id) => {
      return [id, await readModelMetadata(settings, id)]
    })
    applyCapabilities(new Map(entries))
  }
  await refreshManagedModels()
  const modelContext = (model) => {
    if (!settings.autoNctx) return null
    const context = modelContexts.get(model) ?? settings.contextWindow
    return typeof context === 'number' && context > 0 ? context : null
  }
  const useMtp = (model) => {
    return settings.mtp
      && settings.protocol === 'geniex'
      && mtpModels.has(model)
      && !visionModels.has(model)
  }
  const ownsModel = (model) => {
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
        const metric = buildTurnMetric(event, first, starts.get(key) ?? first)
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
    const metric = buildTurnMetric(event, first, start)
    if (metric === null) return
    turnMetrics.set(`${session.id}:${turn}`, metric)
    trimMap(turnMetrics, 2000)
  }), `${SCOPE}: turn metrics`)

  const state = () => ({
    ...settings,
    proxyBaseURL: proxyBaseURL(settings),
    ...readManagedProvider(ctx, settings),
  })

  const syncProvider = async () => {
    if (settings.mode === 'off') {
      await deleteProvider(ctx, settings)
      managedModels.clear()
      visionModels.clear()
      applyCapabilities()
      modelRevision += 1
      return
    }
    const provider = await upsertProvider(ctx, settings)
    managedModels.clear()
    visionModels.clear()
    for (const id of provider.models) managedModels.add(id)
    for (const id of provider.visionModels) visionModels.add(id)
    applyCapabilities(provider.capabilities)
    modelRevision += 1
  }

  const statusCache = { key: '', at: 0, value: null }
  const readGeniexStatus = async () => {
    const active = settings.mode === 'auto' && settings.protocol === 'geniex' && settings.warm === true
    if (!active) return { active: false, models: [], revision: modelRevision }
    const key = settings.upstream
    if (statusCache.key === key && Date.now() - statusCache.at < 1500) {
      return { ...statusCache.value, revision: modelRevision }
    }
    let value = { active: true, models: [] }
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
        const models = Array.isArray(body?.models)
          ? body.models.filter((model) => typeof model?.id === 'string')
          : []
        value = {
          active: true,
          models: models.map((model) => model.id),
          states: Object.fromEntries(models.map((model) => [model.id, model.state])),
        }
      }
    } catch {
      // A missing status endpoint means the client cannot classify warm models.
    }
    value.revision = modelRevision
    statusCache.key = key
    statusCache.at = Date.now()
    statusCache.value = value
    return value
  }

  let warmQueue = Promise.resolve()
  const api = {
    state: () => state(),
    modelStatus: readGeniexStatus,
    modelInfo: () => ({
      revision: modelRevision,
      models: Object.fromEntries([...managedModels].map((id) => {
        const metadata = modelCapabilities.get(id)
        return [id, {
          abliterated: metadata?.abliterated === true,
          hasMtp: metadata?.hasMtp === true && metadata.pluginId === 'llama_cpp',
          contextLength: typeof metadata?.contextLength === 'number' ? metadata.contextLength : null,
          sampling: metadata?.sampling ?? {},
          tags: metadata?.tags ?? [],
        }]
      })),
    }),
    setMode: async (payload) => {
      const mode = ['off', 'auto'].includes(payload?.mode) ? payload.mode : null
      if (mode === null) throw httpError(400, 'invalid mode')
      if (mode === settings.mode) return state()
      const previous = settings.mode
      settings.mode = mode
      statusCache.at = 0
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
      const locale = text(payload?.locale).toLowerCase()
      const name = locale.startsWith('en') ? 'Reply Only' : '仅回复'
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
        const next = { 'reply-only': { ...reply, name, description: '禁止工具调用，仅进行纯文本对话。' } }
        for (const [key, value] of Object.entries(presets)) {
          if (key !== 'reply-only') next[key] = value
        }
        return { ...config, presets: next }
      })
      return { updated: true, name }
    },
    warm: (payload) => {
      const operation = async () => {
        if (settings.mode !== 'auto' || !settings.warm) throw httpError(409, 'model warmup is disabled')
        const model = text(payload?.model)
        if (model === '' || !managedModels.has(model)) throw httpError(400, 'unknown managed model')
        if (settings.mode !== 'auto' || !settings.warm) throw httpError(409, 'model warmup is disabled')
        const result = await warmUpModel(
          ctx,
          settings,
          model,
          visionModels.has(model),
          modelContext(model),
          useMtp(model),
        )
        statusCache.at = 0
        return { warmed: true, model, ...result }
      }
      const result = warmQueue.then(operation, operation)
      warmQueue = result.catch(() => {})
      return result
    },
    save: async (payload) => {
      const mode = ['off', 'auto', 'always'].includes(payload?.mode) ? payload.mode : settings.mode
      if (typeof payload?.upstream === 'string') assertUpstream(payload.upstream)
      const previous = settings
      const next = normalizeSettings({
        ...settings,
        ...payload,
        mode,
        proxyPort: settings.proxyPort,
      })
      const providerChanged = ['protocol', 'upstream', 'apiKeyEnv', 'contextWindow', 'maxOutputTokens', 'autoNctx']
        .some((key) => next[key] !== previous[key])
      const managedProvider = readManagedProvider(ctx, next).provider
      const providerMissing = next.mode === 'auto'
        && (managedProvider?.exists !== true || !Array.isArray(managedProvider.models) || managedProvider.models.length === 0)
      const providerRemoval = next.mode === 'off' && next.managedProviderId !== null
      const requiresSync = next.mode !== previous.mode || providerChanged || providerMissing || providerRemoval
      const loadChanged = requiresSync
        || next.mtp !== previous.mtp
        || next.compute !== previous.compute
        || next.vitCompute !== previous.vitCompute
      const revisionBefore = modelRevision
      settings = next
      statusCache.at = 0
      try {
        if (requiresSync) await syncProvider()
        settings.lastError = null
      } catch (error) {
        settings.lastError = String(error)
      }
      if (loadChanged && modelRevision === revisionBefore) modelRevision += 1
      await persist()
      return state()
    },
    apply: async () => {
      try {
        await syncProvider()
        settings.lastError = null
      } catch (error) {
        settings.lastError = String(error)
      }
      await persist()
      return state()
    },
    remove: async () => {
      try {
        await deleteProvider(ctx, settings)
        managedModels.clear()
        visionModels.clear()
        applyCapabilities()
        modelRevision += 1
        settings.lastError = null
      } catch (error) {
        settings.lastError = String(error)
      }
      await persist()
      return state()
    },
  }

  let mutationQueue = Promise.resolve()
  const mutate = (operation) => {
    const result = mutationQueue.then(operation, operation)
    mutationQueue = result.catch(() => {})
    return result
  }
  for (const method of ['setMode', 'save', 'apply', 'remove', 'permissionLabel']) {
    const operation = api[method]
    api[method] = (payload) => mutate(() => operation(payload))
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

  const server = http.createServer((req, res) => forward(
    req,
    res,
    settings,
    logger,
    ownsModel,
    (model) => visionModels.has(model),
    modelContext,
    useMtp,
  ))
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
