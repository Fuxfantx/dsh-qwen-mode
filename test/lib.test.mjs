import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGgufHeader, readGgufHeader, reasoningEffortsFromChatTemplate } from '../lib/gguf.js'
import { createThinkState, feedReasoning, flushReasoning, rewriteChunk, rewriteMessage, transformSseEvent } from '../lib/reasoning.js'
import { knownReasoningEfforts, looksLikeVisionModel, pairMtpDrafts } from '../lib/capabilities.js'
import { isSafeRelativePath, splitModelId, shortModelName, trimMap } from '../lib/util.js'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push(`ok - ${name}`)
  } catch (error) {
    results.push(`not ok - ${name}: ${error.stack}`)
    process.exitCode = 1
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    results.push(`ok - ${name}`)
  } catch (error) {
    results.push(`not ok - ${name}: ${error.stack}`)
    process.exitCode = 1
  }
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}
function u64(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}
function str(value) {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([u64(body.length), body])
}
function kvString(key, value) {
  return Buffer.concat([str(key), u32(8), str(value)])
}
function kvU32(key, value) {
  return Buffer.concat([str(key), u32(4), u32(value)])
}
function kvF32(key, value) {
  const buffer = Buffer.alloc(4)
  buffer.writeFloatLE(value)
  return Buffer.concat([str(key), u32(6), buffer])
}
function kvArray(key, values) {
  return Buffer.concat([str(key), u32(9), u32(8), u64(values.length), ...values.map(str)])
}
function tensor(name, dims) {
  return Buffer.concat([
    str(name),
    u32(dims.length),
    ...dims.map(u64),
    u32(0),
    u64(0),
  ])
}

function ggufFixture() {
  const entries = [
    kvString('general.architecture', 'qwen3'),
    kvString('general.name', 'Qwen3.8-27B'),
    kvU32('qwen3.context_length', 40960),
    kvU32('qwen3.nextn_predict_layers', 1),
    kvArray('general.tags', ['Abliterated', 'uncensored']),
    kvF32('general.sampling.temp', 0.7),
    kvU32('general.sampling.top_k', 20),
    kvString('tokenizer.chat_template', '{% if reasoning_effort %}"low" "medium" "high" "xhigh"{% endif %}'),
  ]
  const tensors = [tensor('blk.0.nextn.eh_proj.weight', [16, 8])]
  return Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(3),
    u64(tensors.length),
    u64(entries.length),
    ...entries,
    ...tensors,
  ])
}

// ---- GGUF -----------------------------------------------------------------

test('gguf parses context, MTP, tags, sampling, and template', () => {
  const meta = parseGgufHeader(ggufFixture())
  assert.equal(meta.version, 3)
  assert.equal(meta.architecture, 'qwen3')
  assert.equal(meta.name, 'Qwen3.8-27B')
  assert.equal(meta.contextLength, 40960)
  assert.equal(meta.hasMtp, true)
  assert.equal(meta.abliterated, true)
  assert.deepEqual(meta.sampling, { temperature: meta.sampling.temperature, topK: 20 })
  assert.ok(Math.abs(meta.sampling.temperature - 0.7) < 1e-6)
  assert.deepEqual(meta.tags, ['abliterated', 'uncensored'])
  assert.match(meta.chatTemplate, /reasoning_effort/)
})

test('gguf rejects a truncated prefix as retryable', () => {
  const full = ggufFixture()
  assert.throws(() => parseGgufHeader(full.subarray(0, full.length - 20)), (error) => error.truncated === true)
})

test('gguf rejects a non-GGUF file', () => {
  assert.throws(() => parseGgufHeader(Buffer.from('NOPE')), /not a GGUF file/u)
})

test('template reasoning efforts', () => {
  assert.deepEqual(reasoningEffortsFromChatTemplate('use reasoning_effort "low" or "high"'), { off: null, low: 'low', high: 'high' })
  assert.deepEqual(reasoningEffortsFromChatTemplate('{% if enable_thinking %}'), { off: null, max: 'enabled' })
  assert.equal(reasoningEffortsFromChatTemplate('plain template'), undefined)
})

await testAsync('readGgufHeader grows the read window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-gguf-'))
  try {
    const path = join(directory, 'model.gguf')
    await writeFile(path, ggufFixture())
    const handle = await open(path, 'r')
    try {
      const meta = await readGgufHeader(handle, (await stat(path)).size)
      assert.equal(meta.contextLength, 40960)
    } finally {
      await handle.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// ---- reasoning ------------------------------------------------------------

function delta(content) {
  return { choices: [{ index: 0, delta: { content }, finish_reason: null }] }
}

test('tag split across chunks yields reasoning then content', () => {
  const state = createThinkState()
  assert.deepEqual(feedReasoning('Hello <thi', state), [{ type: 'content', text: 'Hello ' }])
  assert.deepEqual(feedReasoning('nk>plan</think', state), [{ type: 'reasoning', text: 'plan' }])
  assert.deepEqual(feedReasoning('>answer', state), [{ type: 'content', text: 'answer' }])
  assert.deepEqual(flushReasoning(state), [])
})

test('an opening tag is removed from content', () => {
  const state = createThinkState()
  assert.deepEqual(feedReasoning('<think>hidden</think>visible', state), [
    { type: 'reasoning', text: 'hidden' },
    { type: 'content', text: 'visible' },
  ])
})

test('a close tag without an open tag marks prior text as reasoning', () => {
  const state = createThinkState()
  assert.deepEqual(feedReasoning('thought</think>reply', state), [
    { type: 'reasoning', text: 'thought' },
    { type: 'content', text: 'reply' },
  ])
})

test('flush drains a held partial tag as reasoning', () => {
  const state = createThinkState()
  assert.deepEqual(feedReasoning('<think>unfinished<', state), [{ type: 'reasoning', text: 'unfinished' }])
  assert.deepEqual(flushReasoning(state), [{ type: 'reasoning', text: '<' }])
})

test('plain content is untouched (no paragraph guessing)', () => {
  const message = { role: 'assistant', content: 'First paragraph.\n\n## Heading\ntext' }
  assert.equal(rewriteMessage(message), message)
})

test('rewriteMessage rebuilds reasoning_content', () => {
  const message = { role: 'assistant', content: '<think>why</think>answer' }
  assert.deepEqual(rewriteMessage(message), { role: 'assistant', content: 'answer', reasoning_content: 'why' })
})

test('rewriteChunk splits one chunk and keeps finish_reason last', () => {
  const state = createThinkState()
  const chunks = rewriteChunk({ id: 'x', choices: [{ index: 0, delta: { content: 'a<think>b</think>c' }, finish_reason: 'stop' }] }, state)
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks[0].choices[0].delta, { content: 'a' })
  assert.deepEqual(chunks[1].choices[0].delta, { reasoning_content: 'b' })
  assert.deepEqual(chunks[2].choices[0].delta, { content: 'c' })
  assert.equal(chunks[0].choices[0].finish_reason, null)
  assert.equal(chunks[2].choices[0].finish_reason, 'stop')
})

test('rewriteChunk flushes held reasoning with the finish chunk', () => {
  const state = createThinkState()
  const first = rewriteChunk(delta('<think>held<'), state)
  assert.deepEqual(first[0].choices[0].delta, { reasoning_content: 'held' })
  const chunks = rewriteChunk({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] }, state)
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0].choices[0].delta, { reasoning_content: '<' })
  assert.equal(chunks[0].choices[0].finish_reason, 'stop')
})

test('server-separated reasoning passes through untouched', () => {
  const state = createThinkState()
  const chunk = { choices: [{ index: 0, delta: { reasoning_content: 'why' }, finish_reason: null }] }
  assert.deepEqual(rewriteChunk(chunk, state), [chunk])
  const content = delta('<think>literal</think>')
  assert.deepEqual(rewriteChunk(content, state), [content])
})

test('SSE transform handles chunked data and DONE flush', () => {
  const state = createThinkState()
  const meta = { onUsage: () => {} }
  const out = transformSseEvent(`data: ${JSON.stringify(delta('hi <think>thinking'))}`, state, meta)
  assert.match(out, /"content":"hi "/u)
  assert.match(out, /"reasoning_content":"thinking"/u)
  const done = transformSseEvent('data: [DONE]', state, meta)
  assert.match(done, /^data: \[DONE\]\n\n$/u)
})

test('SSE transform preserves malformed events', () => {
  const state = createThinkState()
  assert.equal(transformSseEvent('data: not-json', state, {}), 'data: not-json\n\n')
  assert.equal(transformSseEvent(': keep-alive', state, {}), ': keep-alive\n\n')
})

// ---- capabilities ---------------------------------------------------------

test('draft pairing follows GenieX assistant models', () => {
  const pairs = pairMtpDrafts([
    'google/gemma-4-26B-A4B-it-qat-q4_0-gguf:Q4_0',
    'RachidAR/gemma-4-26B-A4B-it-qat-assistant-q4_0-gguf:Q4_0',
    'google/gemma-4-26B-A4B-it-qat-q4_0-gguf:Q8_0',
  ])
  assert.equal(pairs.get('RachidAR/gemma-4-26B-A4B-it-qat-assistant-q4_0-gguf:Q4_0'), 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf:Q4_0')
  assert.equal(pairs.size, 1)
})

test('unrelated assistant-named models are not paired', () => {
  assert.equal(pairMtpDrafts(['org/assistant-model:Q4_0', 'org/other-model:Q4_0']).size, 0)
})

test('known thinking families', () => {
  assert.deepEqual(knownReasoningEfforts('Qwen3.8-27B'), { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' })
  assert.equal(knownReasoningEfforts('Qwen3-Coder-Plus'), false)
  assert.deepEqual(knownReasoningEfforts('Qwen3-4B'), { off: null, max: 'enabled' })
  assert.equal(knownReasoningEfforts('Llama-3.3-70B'), undefined)
})

test('vision names', () => {
  assert.equal(looksLikeVisionModel('Qwen3-VL-4B-Instruct'), true)
  assert.equal(looksLikeVisionModel('org/qwen2.5-vl:Q4_0'), true)
  assert.equal(looksLikeVisionModel('Qwen3-4B-Instruct'), false)
})

// ---- util -----------------------------------------------------------------

test('splitModelId separates owner and precision', () => {
  assert.deepEqual(splitModelId('ai-hub-models/Qwen3-4B:Q4_0'), {
    owner: 'ai-hub-models', leaf: 'Qwen3-4B', precision: 'Q4_0', name: 'ai-hub-models/Qwen3-4B',
  })
  assert.deepEqual(splitModelId('local:Q8_0'), { owner: '', leaf: 'local', precision: 'Q8_0', name: 'local' })
  assert.deepEqual(splitModelId('org/sub/leaf'), { owner: 'org', leaf: 'sub/leaf', precision: '', name: 'org/sub/leaf' })
  assert.equal(shortModelName('ai-hub-models/Qwen3-4B:Q4_0'), 'Qwen3-4B')
})

test('safe paths reject traversal', () => {
  assert.equal(isSafeRelativePath('model.gguf'), true)
  assert.equal(isSafeRelativePath('Q4_0/model.gguf'), true)
  assert.equal(isSafeRelativePath('../model.gguf'), false)
  assert.equal(isSafeRelativePath('/abs/model.gguf'), false)
  assert.equal(isSafeRelativePath('a/../../b'), false)
})

test('trimMap keeps the newest entries', () => {
  const map = new Map([['a', 1], ['b', 2], ['c', 3]])
  trimMap(map, 2)
  assert.deepEqual([...map.keys()], ['b', 'c'])
})

console.log(results.join('\n'))
