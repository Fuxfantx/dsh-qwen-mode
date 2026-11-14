/**
 * Thinking-tag normalization for OpenAI-compatible streams.
 *
 * GenieX separates reasoning into `reasoning_content` when asked, and Qwen's
 * hosted API does the same, so the usual path is a byte-for-byte pass-through.
 * Some OpenAI-compatible Qwen deployments still inline the template's
 * ` thinking ... <｜end▁of▁thinking｜>` block in `content`; this module rebuilds the
 * `reasoning_content` field for those, using only explicit tags. It never
 * guesses which paragraph is reasoning from formatting alone.
 *
 * @module dsh-qwen-mode/lib/reasoning
 */

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

/** One stream's tag-splitting state. */
export function createThinkState() {
  return { buffer: '', inThink: false, separated: false, serverSeparated: false }
}

/** Length of `buffer` that cannot end inside a partial tag. */
function safePrefix(buffer) {
  const index = buffer.lastIndexOf('<')
  if (index === -1) return buffer.length
  const tail = buffer.slice(index)
  return OPEN_TAG.startsWith(tail) || CLOSE_TAG.startsWith(tail) ? index : buffer.length
}

function pushPiece(out, type, value) {
  if (value !== '') out.push({ type, text: value })
}

function take(out, type, state, end) {
  pushPiece(out, type, state.buffer.slice(0, end))
  state.buffer = state.buffer.slice(end)
}

/**
 * Feed one content delta into the tag splitter.
 * @param value - the delta text.
 * @param state - this stream's state.
 * @returns ordered `{ type: 'content' | 'reasoning', text }` pieces.
 */
export function feedReasoning(value, state) {
  if (state.serverSeparated) {
    return value === '' ? [] : [{ type: 'content', text: value }]
  }
  state.buffer += value
  const out = []
  while (state.buffer !== '') {
    if (state.separated) {
      take(out, 'content', state, state.buffer.length)
      break
    }
    if (!state.inThink) {
      const open = state.buffer.indexOf(OPEN_TAG)
      const close = state.buffer.indexOf(CLOSE_TAG)
      if (open !== -1 && (close === -1 || open < close)) {
        take(out, 'content', state, open)
        state.buffer = state.buffer.slice(OPEN_TAG.length)
        state.inThink = true
        continue
      }
      if (close !== -1) {
        // The template consumed the opening tag, so this text is reasoning.
        take(out, 'reasoning', state, close)
        state.buffer = state.buffer.slice(CLOSE_TAG.length)
        state.inThink = false
        state.separated = true
        continue
      }
      const safe = safePrefix(state.buffer)
      if (safe > 0) take(out, 'content', state, safe)
      break
    }
    const close = state.buffer.indexOf(CLOSE_TAG)
    if (close === -1) {
      const safe = safePrefix(state.buffer)
      if (safe > 0) take(out, 'reasoning', state, safe)
      break
    }
    take(out, 'reasoning', state, close)
    state.buffer = state.buffer.slice(CLOSE_TAG.length)
    state.inThink = false
    state.separated = true
  }
  return out
}

/**
 * Drain text held back for a possible split tag.
 * @returns the remaining pieces; `state.buffer` is left empty.
 */
export function flushReasoning(state) {
  const out = []
  if (state.buffer === '') return out
  pushPiece(out, state.serverSeparated ? 'content' : state.inThink ? 'reasoning' : 'content', state.buffer)
  state.buffer = ''
  return out
}

/** Rewrite one complete (non-streaming) assistant message. */
export function rewriteMessage(message) {
  if (message === null || typeof message !== 'object' || typeof message.content !== 'string') return message
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim() !== '') return message
  const state = createThinkState()
  const pieces = [...feedReasoning(message.content, state), ...flushReasoning(state)]
  const reasoning = pieces.filter((piece) => piece.type === 'reasoning').map((piece) => piece.text).join('')
  const content = pieces.filter((piece) => piece.type === 'content').map((piece) => piece.text).join('')
  if (reasoning === '') return content === message.content ? message : { ...message, content }
  return {
    ...message,
    content,
    reasoning_content: `${message.reasoning_content ?? ''}${reasoning}`,
  }
}

function completionChunk(chunk, choice, delta, finishReason) {
  return {
    ...chunk,
    choices: [{ ...choice, delta, finish_reason: finishReason }],
  }
}

/**
 * Rewrite one streaming chunk into zero or more chunks.
 *
 * A `finish_reason` on the upstream chunk is attached to the last piece this
 * call emits, and any held reasoning is flushed first, so a client that stops
 * consuming at `finish_reason` still receives the complete reasoning block.
 * Requests use `n: 1`, so the tag splitter is shared by every choice in a
 * chunk rather than tracking one state per choice.
 * @param chunk - parsed upstream chunk.
 * @param state - this stream's state.
 * @returns chunks to forward, in order.
 */
export function rewriteChunk(chunk, state) {
  if (chunk === null || typeof chunk !== 'object' || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
    return [chunk]
  }
  const out = []
  for (const choice of chunk.choices) {
    const delta = choice?.delta
    const finish = choice?.finish_reason ?? null
    const emit = (nextDelta, nextFinish = finish) => {
      out.push(completionChunk(chunk, choice, nextDelta, nextFinish))
    }
    if (delta === null || typeof delta !== 'object') {
      out.push({ ...chunk, choices: [choice] })
      continue
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      // The upstream switched to a separate reasoning field mid-stream. Text
      // held for a possible `<think>` split is visible content, not reasoning.
      if (state.buffer !== '') {
        const held = state.buffer
        state.buffer = ''
        emit({ content: held }, null)
      }
      state.serverSeparated = true
      emit(delta)
      continue
    }
    if (state.serverSeparated || typeof delta.content !== 'string') {
      emit(delta)
      continue
    }
    if (delta.content === '' && state.buffer === '') {
      emit(delta)
      continue
    }
    const pieces = feedReasoning(delta.content, state)
    if (finish !== null) pieces.push(...flushReasoning(state))
    if (pieces.length === 0) {
      emit({ ...delta, content: '' })
      continue
    }
    for (const [index, piece] of pieces.entries()) {
      const nextDelta = index === 0 ? { ...delta } : {}
      delete nextDelta.content
      delete nextDelta.reasoning_content
      nextDelta[piece.type === 'reasoning' ? 'reasoning_content' : 'content'] = piece.text
      emit(nextDelta, index === pieces.length - 1 ? finish : null)
    }
  }
  return out
}

/** Format one SSE data event. */
export function sseEvent(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/** Extend this metadata object with the last seen id/created/model. */
function rememberMeta(meta, parsed) {
  if (typeof parsed?.id === 'string') meta.id = parsed.id
  if (parsed?.created !== undefined) meta.created = parsed.created
  if (typeof parsed?.model === 'string') meta.model = parsed.model
}

function doneEvent(meta) {
  return {
    id: meta.id ?? 'qwen-mode',
    object: 'chat.completion.chunk',
    created: meta.created ?? Math.floor(Date.now() / 1000),
    model: meta.model ?? '',
  }
}

/**
 * Transform one raw SSE event block.
 * @param raw - event text without its blank-line terminator.
 * @param state - this stream's state.
 * @param meta - stream metadata also used to synthesize the final flush.
 * @returns the rewritten SSE text, terminator included.
 */
export function transformSseEvent(raw, state, meta) {
  // Once the upstream has switched to a separate reasoning field, ordinary
  // content chunks need no parsing or re-serialization; forward them raw.
  if (state.serverSeparated && !raw.includes('"usage"') && !raw.includes('<think>') && !raw.includes('[DONE]')) {
    return `${raw}\n\n`
  }
  const data = raw
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /u, ''))
    .join('\n')
  if (data === '') return `${raw}\n\n`
  if (data.trim() === '[DONE]') {
    let output = ''
    for (const piece of flushReasoning(state)) {
      output += sseEvent({
        ...doneEvent(meta),
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
  rememberMeta(meta, parsed)
  if (parsed?.usage !== undefined && typeof meta.onUsage === 'function') meta.onUsage(parsed.usage)
  return rewriteChunk(parsed, state).map(sseEvent).join('')
}
