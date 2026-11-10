/**
 * GGUF header reader.
 *
 * GenieX caches each model as a manifest (`geniex.json`) plus the downloaded
 * weights, and the GGUF header carries everything the plugin needs about a
 * model: trained context length, chat template, sampling recommendations, tags,
 * and whether it ships MTP tensors. The header is read incrementally so a
 * normal model costs one 1 MiB read instead of a fixed 32 MiB allocation.
 *
 * @module dsh-qwen-mode/lib/gguf
 */

/** Largest prefix of a GGUF file the metadata reader will load. */
const GGUF_PREFIX_LIMIT = 32 * 1024 * 1024

/** Bytes consumed by each GGUF scalar metadata type. */
const SCALAR_BYTES = new Map([
  [0, 1], [1, 1], [2, 2], [3, 2], [4, 4], [5, 4], [6, 4], [7, 1], [10, 8], [11, 8], [12, 8],
])

/** Sampling defaults a GGUF may recommend, keyed by metadata name. */
const SAMPLING_KEYS = {
  'general.sampling.temp': 'temperature',
  'general.sampling.temperature': 'temperature',
  'general.sampling.top_k': 'topK',
  'general.sampling.top_p': 'topP',
  'general.sampling.min_p': 'minP',
  'general.sampling.presence_penalty': 'presencePenalty',
  'general.sampling.frequency_penalty': 'frequencyPenalty',
  'general.sampling.repetition_penalty': 'repetitionPenalty',
}

/** MTP tensor names llama.cpp uses for built-in prediction heads. */
const MTP_TENSOR_PATTERN = /nextn|mtp|draft_head/iu

/** Upper bounds that keep a corrupt header from spinning the parser. */
const MAX_KV_COUNT = 1 << 20
const MAX_TENSOR_COUNT = 1 << 22
const MAX_TENSOR_DIMENSIONS = 8

function truncated(message) {
  const error = new Error(message)
  error.truncated = true
  return error
}

/**
 * Derive the thinking levels a chat template supports.
 * @param template - the model's chat template, or the empty string.
 * @returns a `reasoningEfforts` map, or undefined when the template says nothing.
 */
export function reasoningEffortsFromChatTemplate(template) {
  if (typeof template !== 'string' || template === '') return undefined
  if (template.includes('reasoning_effort')) {
    const levels = new Set()
    for (const match of template.matchAll(/['"](low|medium|high|xhigh)['"]/gu)) levels.add(match[1])
    if (levels.size === 0) return undefined
    const efforts = { off: null }
    for (const level of levels) efforts[level] = level
    return efforts
  }
  if (template.includes('enable_thinking')) return { off: null, max: 'enabled' }
  return undefined
}

/**
 * Parse the metadata section of a GGUF file.
 * @param buffer - a prefix of the file, at least covering the metadata section.
 * @returns every field the plugin consumes.
 * @throws an Error with `truncated: true` when `buffer` is too short.
 */
export function parseGgufHeader(buffer) {
  let offset = 0
  const remaining = () => buffer.length - offset
  const need = (size) => {
    if (remaining() < size) throw truncated('truncated GGUF header')
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
    if (length > remaining()) throw truncated('truncated GGUF string')
    const value = buffer.toString('utf8', offset, offset + length)
    offset += length
    return value
  }
  const skipString = () => {
    const length = u64()
    if (length > remaining()) throw truncated('truncated GGUF string')
    offset += length
  }
  const skipValue = (type, depth = 0) => {
    if (depth > 8) throw new Error('GGUF nesting too deep')
    if (SCALAR_BYTES.has(type)) {
      need(SCALAR_BYTES.get(type))
      offset += SCALAR_BYTES.get(type)
      return
    }
    if (type === 8) {
      skipString()
      return
    }
    if (type !== 9) throw new Error(`unsupported GGUF type ${type}`)
    const inner = u32()
    const count = u64()
    if (count > remaining()) throw truncated('truncated GGUF array')
    for (let index = 0; index < count; index += 1) skipValue(inner, depth + 1)
  }
  const readScalar = (type) => {
    switch (type) {
      case 0: need(1); return buffer.readUInt8(offset++)
      case 1: need(1); return buffer.readInt8(offset++)
      case 2: { need(2); const value = buffer.readUInt16LE(offset); offset += 2; return value }
      case 3: { need(2); const value = buffer.readInt16LE(offset); offset += 2; return value }
      case 4: return u32()
      case 5: { need(4); const value = buffer.readInt32LE(offset); offset += 4; return value }
      case 6: { need(4); const value = buffer.readFloatLE(offset); offset += 4; return value }
      case 7: need(1); return buffer.readUInt8(offset++) !== 0
      case 10: return u64()
      case 11: { need(8); const value = Number(buffer.readBigInt64LE(offset)); offset += 8; return value }
      case 12: { need(8); const value = buffer.readDoubleLE(offset); offset += 8; return value }
      default: throw new Error(`unsupported GGUF scalar ${type}`)
    }
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
  if (kvCount > MAX_KV_COUNT) throw new Error(`implausible GGUF metadata count ${kvCount}`)
  if (tensorCount > MAX_TENSOR_COUNT) throw new Error(`implausible GGUF tensor count ${tensorCount}`)
  // Every metadata entry costs at least its 8-byte key length; refuse a count
  // that cannot possibly fit before the loop turns into a scan.
  if (kvCount * 8 > remaining()) throw truncated('truncated GGUF metadata')

  const meta = Object.create(null)
  const templates = []
  for (let index = 0; index < kvCount; index += 1) {
    const key = string()
    const type = u32()
    if (type === 8) {
      if (key === 'tokenizer.chat_template') templates.push(string())
      else if (key === 'general.name' || key === 'general.finetune' || key === 'general.basename' || key === 'general.architecture') {
        meta[key] = string()
      } else skipString()
    } else if (type === 9) {
      const inner = u32()
      const count = u64()
      if (count > remaining()) throw truncated('truncated GGUF array')
      if (inner === 8 && (key === 'general.tags' || key === 'tokenizer.chat_templates')) {
        const values = readStringArray(count)
        if (key === 'general.tags') meta[key] = values
        else templates.push(...values)
      } else {
        for (let item = 0; item < count; item += 1) skipValue(inner)
      }
    } else {
      meta[key] = readScalar(type)
    }
  }

  let hasMtp = Object.entries(meta).some(([key, value]) => {
    return /nextn_predict_layers|mtp/iu.test(key) && typeof value === 'number' && value > 0
  })
  for (let index = 0; index < tensorCount; index += 1) {
    const name = string()
    if (MTP_TENSOR_PATTERN.test(name)) hasMtp = true
    const dimensions = u32()
    if (dimensions > MAX_TENSOR_DIMENSIONS) throw new Error(`implausible GGUF tensor rank ${dimensions}`)
    need(dimensions * 8 + 12)
    offset += dimensions * 8 + 12
  }

  const architecture = typeof meta['general.architecture'] === 'string' ? meta['general.architecture'] : ''
  const architectureContext = architecture === '' ? undefined : meta[`${architecture}.context_length`]
  const contextKey = Object.keys(meta).find((key) => key.endsWith('.context_length'))
  const contextLength = positiveInteger(
    typeof architectureContext === 'number' ? architectureContext : contextKey === undefined ? null : meta[contextKey],
  )
  const tags = Array.isArray(meta['general.tags'])
    ? meta['general.tags'].map((tag) => String(tag).toLowerCase())
    : []
  const sampling = {}
  for (const [key, field] of Object.entries(SAMPLING_KEYS)) {
    const value = meta[key]
    if (typeof value === 'number' && Number.isFinite(value)) sampling[field] = value
  }

  return {
    version,
    tensorCount,
    architecture,
    name: typeof meta['general.name'] === 'string' ? meta['general.name'] : '',
    finetune: typeof meta['general.finetune'] === 'string' ? meta['general.finetune'] : '',
    contextLength,
    hasMtp,
    tags,
    abliterated: tags.some((tag) => tag.includes('abliterat') || tag.includes('uncensored') || tag.includes('refusal-direction')),
    sampling,
    chatTemplate: templates.join('\n'),
  }
}

function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Read and parse a GGUF header, growing the read window only when the metadata
 * section does not fit.
 * @param handle - open FileHandle positioned on the GGUF file.
 * @param fileSize - the file's size in bytes.
 * @returns the parsed header.
 */
export async function readGgufHeader(handle, fileSize) {
  const limit = Math.min(fileSize, GGUF_PREFIX_LIMIT)
  if (limit <= 0) throw new Error('empty GGUF file')
  let size = Math.min(limit, 1024 * 1024)
  for (;;) {
    const buffer = Buffer.allocUnsafe(size)
    let bytesRead = 0
    // A single fs.read may return a short buffer even before EOF; fill the
    // window before deciding the metadata section is truncated.
    while (bytesRead < size) {
      const result = await handle.read(buffer, bytesRead, size - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    try {
      return parseGgufHeader(buffer.subarray(0, bytesRead))
    } catch (error) {
      if (error?.truncated !== true || size >= limit) throw error
      size = Math.min(limit, size * 4)
    }
  }
}
