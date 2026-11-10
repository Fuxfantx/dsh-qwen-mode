import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const root = await mkdtemp(join(tmpdir(), 'qwen-mode-plugin-'))
const home = join(root, 'home')
const cacheRoot = join(home, '.cache', 'geniex', 'models')
const modelDir = join(cacheRoot, 'org', 'qwen3.8-27b')
const draftDir = join(cacheRoot, 'org', 'qwen3.8-27b-assistant')
const qairtDir = join(cacheRoot, 'qnn', 'qwen3-8b')
const qairtAssistantDir = join(cacheRoot, 'qnn', 'qwen3-8b-assistant')
for (const directory of [modelDir, draftDir, qairtDir, qairtAssistantDir]) {
  await mkdir(directory, { recursive: true })
}

// Isolate the GenieX CLI lookup (none on PATH) and the cache fallback.
const emptyPath = join(root, 'bin')
await mkdir(emptyPath, { recursive: true })
const savedEnv = { PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR }
process.env.PATH = emptyPath
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_PROFILE_DIR = join(root, 'profile')

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
function gguf({ context, template, name, mtp = false }) {
  const entries = [
    Buffer.concat([str('general.architecture'), u32(8), str('qwen3')]),
    Buffer.concat([str('general.name'), u32(8), str(name)]),
    Buffer.concat([str('qwen3.context_length'), u32(4), u32(context)]),
    Buffer.concat([str('tokenizer.chat_template'), u32(8), str(template)]),
  ]
  const tensors = mtp
    ? [Buffer.concat([str('blk.0.nextn.eh_proj.weight'), u32(1), u64(16), u32(0), u64(0)])]
    : []
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), u32(3), u64(tensors.length), u64(entries.length), ...entries, ...tensors])
}

await writeFile(join(modelDir, 'model.gguf'), gguf({
  context: 40960,
  template: '{% if reasoning_effort %}"low" "high"{% endif %}',
  name: 'Qwen3.8-27B',
  mtp: true,
}))
await writeFile(join(modelDir, 'mtp-Q4_0.gguf'), Buffer.from('draft weights placeholder'))
const sidecarPath = join(modelDir, 'mtp-Q4_0.gguf')
await writeFile(join(modelDir, 'geniex.json'), JSON.stringify({
  ModelType: 'vlm',
  PluginId: 'llama_cpp',
  ModelFile: { Q4_0: { Name: 'model.gguf', Downloaded: true } },
}))
await writeFile(join(draftDir, 'draft.gguf'), gguf({ context: 40960, template: '', name: 'Qwen3.8 assistant' }))
await writeFile(join(draftDir, 'geniex.json'), JSON.stringify({
  ModelType: 'llm',
  PluginId: 'llama_cpp',
  ModelFile: { Q4_0: { Name: 'draft.gguf', Downloaded: true } },
}))
for (const directory of [qairtDir, qairtAssistantDir]) {
  await writeFile(join(directory, 'geniex.json'), JSON.stringify({ ModelType: 'llm', PluginId: 'qairt' }))
}

const upstreamRequests = []
const qwenRequests = []
let modelsGate = null
let releaseModels = null

function geniexUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      upstreamRequests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (req.url === '/v1/models') {
        if (modelsGate !== null) await modelsGate
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'org/qwen3.8-27b:Q4_0' },
            { id: 'org/qwen3.8-27b-assistant:Q4_0' },
            { id: 'qnn/qwen3-8b' },
            { id: 'qnn/qwen3-8b-assistant' },
          ],
        }))
        return
      }
      if (req.url === '/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ alive: true, models: [{ id: 'org/qwen3.8-27b:Q4_0', state: 'active' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
        res.write(chunk({ id: 'chat-1', created: 1, model: 'org/qwen3.8-27b:Q4_0', choices: [{ index: 0, delta: { content: '<think>thinking' }, finish_reason: null }] }))
        res.write(chunk({ id: 'chat-1', created: 1, model: 'org/qwen3.8-27b:Q4_0', choices: [{ index: 0, delta: { content: '</think>answer' }, finish_reason: null }] }))
        res.write(chunk({
          id: 'chat-1',
          created: 1,
          model: 'org/qwen3.8-27b:Q4_0',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 2 },
            completion_tokens_details: { accepted_prediction_tokens: 2, rejected_prediction_tokens: 1 },
          },
        }))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(404).end()
    })
  })
  return server
}

function qwenUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      qwenRequests.push({ url: req.url, headers: req.headers, body: raw })
      if (req.url.startsWith('/api/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          output: {
            total: 5,
            page_no: 1,
            page_size: 100,
            models: [
              {
                model: 'qwen3.8-max',
                capabilities: ['TG', 'Reasoning'],
                inference_metadata: { request_modality: ['Text'], response_modality: ['Text'] },
                model_info: { context_window: 262144, max_output_tokens: 65536 },
              },
              {
                model: 'qwen3.6-plus',
                capabilities: ['TG', 'Reasoning'],
                inference_metadata: { request_modality: ['Text'], response_modality: ['Text'] },
                model_info: { context_window: 262144, max_output_tokens: 32768 },
              },
              {
                model: 'qwen3-coder-plus',
                capabilities: ['TG'],
                inference_metadata: { request_modality: ['Text'], response_modality: ['Text'] },
                model_info: { context_window: 262144, max_output_tokens: 16384 },
              },
              {
                model: 'qwen3-vl-plus',
                capabilities: ['TG', 'Reasoning', 'VU'],
                inference_metadata: { request_modality: ['Text', 'Image'], response_modality: ['Text'] },
                model_info: { context_window: 131072, max_output_tokens: 16384 },
              },
              {
                model: 'qwen-image-3.0-pro',
                capabilities: ['IG'],
                inference_metadata: { request_modality: ['Text'], response_modality: ['Image'] },
                model_info: { context_window: null, max_output_tokens: null },
              },
            ],
          },
        }))
        return
      }
      if (req.url.endsWith('/models')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chat-2',
        created: 1,
        model: JSON.parse(raw).model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }))
    })
  })
  return server
}

const upstream = geniexUpstream()
const qwen = qwenUpstream()
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => qwen.listen(0, '127.0.0.1', resolve))
const upstreamURL = `http://127.0.0.1:${upstream.address().port}`
const qwenURL = `http://127.0.0.1:${qwen.address().port}/compatible-mode/v1`

// ---- mock Cordis context --------------------------------------------------

function createContext(entryConfig) {
  const routes = []
  const effects = []
  const credentials = new Map()
  const config = { providers: {} }
  const entry = { options: { id: 'llm-pi-ai', config }, id: 'include:llm-pi-ai' }
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    on: () => () => {},
    emit: () => {},
    tools: { guard: () => () => {} },
    agents: { list: () => [], get: () => undefined },
    sessions: { get: () => undefined },
    permissionPresets: { current: () => 'custom' },
    credentials: {
      resolve: async (ref) => (credentials.has(ref) ? { value: credentials.get(ref) } : undefined),
      set: async (ref, value) => { credentials.set(ref, value) },
      has: (ref) => credentials.has(ref),
    },
    connection: { requestRejection: () => undefined },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    configEditor: {
      entries: () => [entry],
      configuration: () => [{ entry, inherited: {}, override: structuredClone(config) }],
      edit: async (target, change) => {
        const next = change(structuredClone(config), {})
        for (const key of Object.keys(config)) delete config[key]
        Object.assign(config, next)
      },
    },
    routes,
    effects,
    config,
  }
  return ctx
}

function callApi(ctx, method, payload = {}) {
  const route = ctx.routes.find((candidate) => candidate.path === '/qwen-mode/api')
  assert.ok(route, 'settings API registered')
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))])
    req.method = 'POST'
    req.url = `/qwen-mode/api/${method}`
    req.headers = { 'content-type': 'application/json' }
    const chunks = []
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}) },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          reject(new Error(`non-JSON API response: ${body}`))
          return
        }
        resolve({ status: this.statusCode, body: parsed })
      },
      flushHeaders() {},
      writableEnded: false,
    }
    route.handler(req, res).catch(reject)
  })
}

async function callProxy(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`ok - ${name}`)
  } catch (error) {
    results.push(`not ok - ${name}: ${error.stack}`)
    process.exitCode = 1
  }
}

try {
  const { apply } = await import('../index.js')
  const ctx = createContext()
  await apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 250))

  let state = (await callApi(ctx, 'state')).body.value
  check('starts with defaults', () => {
    assert.equal(state.mode, 'off')
    assert.equal(state.maxOutputTokens, 16384)
  })

  const saved = (await callApi(ctx, 'save', {
    mode: 'auto',
    warm: true,
    protocol: 'geniex',
    upstream: upstreamURL,
    contextWindow: null,
    maxOutputTokens: 4096,
    autoNctx: false,
    mtp: true,
    compute: 'npu',
    vitCompute: 'npu',
  })).body
  assert.equal(saved.ok, true, JSON.stringify(saved))
  state = saved.value
  const port = state.proxyPort

  const provider = ctx.config['providers']['from-geniex']
  const modelById = (id) => ctx.config['providers']['from-geniex']?.models.find((model) => model.id === id)
  check('provider keeps GGUF chats and hides the paired QAIRT draft', () => {
    assert.deepEqual(provider.models.map((model) => model.id), [
      'org/qwen3.8-27b:Q4_0',
      'org/qwen3.8-27b-assistant:Q4_0',
      'qnn/qwen3-8b',
    ])
    assert.equal(provider.baseURL, `http://127.0.0.1:${port}/v1`)
    assert.equal(provider.apiKeyEnv, 'local')
    assert.equal(provider.compat.thinkingFormat, 'qwen')
    assert.equal(provider.compat.maxTokensField, 'max_completion_tokens')
  })
  check('model metadata comes from the local cache', () => {
    const model = modelById('org/qwen3.8-27b:Q4_0')
    assert.equal(model.contextWindow, 40960)
    assert.equal(model.maxTokens, 4096)
    assert.deepEqual(model.input, ['text', 'image'])
    assert.deepEqual(model.reasoningEfforts, { off: null, low: 'low', high: 'high' })
  })
  check('a missing local credential is created for GenieX', () => {
    assert.equal(ctx.credentials.has('local'), true)
  })
  const contextOf = () => modelById('org/qwen3.8-27b:Q4_0').contextWindow
  await callApi(ctx, 'save', { contextWindow: 8192 })
  check('an explicit context window overrides model metadata', () => {
    assert.equal(contextOf(), 8192)
  })
  await callApi(ctx, 'save', { contextWindow: 8192, autoNctx: true })
  check('prefer-model overrides the explicit value', () => {
    assert.equal(contextOf(), 40960)
  })
  await callApi(ctx, 'save', { contextWindow: null, autoNctx: false })
  check('an empty context falls back to metadata', () => {
    assert.equal(contextOf(), 40960)
  })
  const restored = (await callApi(ctx, 'state')).body.value
  check('context changes persist in state', () => {
    assert.equal(restored.contextWindow, null)
    assert.equal(restored.autoNctx, false)
  })
  check('vision is resolved without the HTTP detail endpoint', () => {
    assert.equal(upstreamRequests.some((request) => request.url.startsWith('/v1/models/')), false)
  })

  const info = (await callApi(ctx, 'modelInfo')).body.value
  check('GGUF MTP needs its tensors and an injected sidecar', () => {
    const entry = info.models['org/qwen3.8-27b:Q4_0']
    assert.equal(entry.vision, true)
    assert.equal(entry.mtpReady, true)
    assert.equal(entry.contextLength, 40960)
    assert.equal(entry.abliterated, false)
    assert.equal(info.models['org/qwen3.8-27b-assistant:Q4_0'].mtpReady, false)
  })
  check('QAIRT MTP uses the paired assistant and stays hidden', () => {
    assert.equal(info.models['qnn/qwen3-8b'].mtpReady, true)
    assert.equal(info.models['qnn/qwen3-8b-assistant'], undefined)
  })
  check('state exposes the managed provider', () => {
    assert.equal(state.provider.exists, true)
    assert.deepEqual(state.provider.models, [
      'org/qwen3.8-27b:Q4_0',
      'org/qwen3.8-27b-assistant:Q4_0',
      'qnn/qwen3-8b',
    ])
  })

  const media = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]
  const first = await callProxy(port, {
    model: 'org/qwen3.8-27b:Q4_0',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, ...media] }],
    stream: true,
    max_completion_tokens: 999999,
    temperature: 0.2,
    reasoning_effort: 'high',
  })
  check('proxy response rewrites inline reasoning', () => {
    assert.equal(first.status, 200)
    assert.match(first.text, /"reasoning_content":"thinking"/u)
    assert.match(first.text, /"content":"answer"/u)
    assert.match(first.text, /"finish_reason":"stop"/u)
    assert.match(first.text, /data: \[DONE\]/u)
  })
  const firstBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  check('request normalization matches GenieX and DSH expectations', () => {
    assert.equal(firstBody.enable_think, true)
    assert.equal(firstBody.reasoning_format, 'auto')
    assert.equal(firstBody.nctx, 40960)
    assert.equal(firstBody.max_completion_tokens, 40960)
    assert.equal(firstBody.vit_compute, 'HTP2')
    assert.equal(firstBody.compute, 'npu')
    assert.equal(firstBody.reasoning_effort, 'high')
    assert.equal(firstBody.temperature, 0.2)
    assert.equal(firstBody.stream_options.include_usage, true)
    assert.equal(firstBody.spec_type, undefined)
  })

  await callApi(ctx, 'mtpChoice', { model: 'org/qwen3.8-27b:Q4_0', allow: true })
  await callProxy(port, {
    model: 'org/qwen3.8-27b:Q4_0',
    messages: [{ role: 'user', content: media }],
    stream: false,
  })
  const mtpBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  check('approved MTP attaches the injected sidecar path', () => {
    assert.equal(mtpBody.spec_type, 'draft-mtp')
    assert.equal(mtpBody.spec_draft_model, sidecarPath)
    assert.equal(mtpBody.spec_n_max, 3)
  })
  await callProxy(port, {
    model: 'org/qwen3.8-27b:Q4_0',
    messages: [{ role: 'user', content: media }],
    stream: false,
  })
  const afterBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  check('the image approval is consumed after one request', () => {
    assert.equal(afterBody.spec_type, undefined)
  })
  await callProxy(port, {
    model: 'org/qwen3.8-27b:Q4_0',
    messages: [{ role: 'user', content: 'text only' }],
    stream: false,
  })
  const textBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  check('text-only requests keep MTP enabled', () => {
    assert.equal(textBody.spec_type, 'draft-mtp')
  })
  await callProxy(port, {
    model: 'qnn/qwen3-8b',
    messages: [{ role: 'user', content: 'qairt text' }],
    stream: false,
  })
  const qairtBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  check('QAIRT MTP names the paired assistant model without llama.cpp knobs', () => {
    assert.equal(qairtBody.spec_type, 'draft-mtp')
    assert.equal(qairtBody.spec_draft_model, 'qnn/qwen3-8b-assistant')
    assert.equal(qairtBody.spec_n_max, undefined)
    assert.equal(qairtBody.spec_n_min, undefined)
    assert.equal(qairtBody.spec_p_min, undefined)
  })
  const loadFieldsOf = (body) => ({
    nctx: body.nctx,
    compute: body.compute,
    vit_compute: body.vit_compute,
    spec_type: body.spec_type,
    spec_draft_model: body.spec_draft_model,
    spec_n_max: body.spec_n_max,
    spec_n_min: body.spec_n_min,
    spec_p_min: body.spec_p_min,
  })
  await callApi(ctx, 'warm', { model: 'qnn/qwen3-8b' })
  const qairtWarmBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  await callProxy(port, {
    model: 'qnn/qwen3-8b',
    messages: [{ role: 'user', content: 'qairt after warm' }],
    stream: false,
  })
  const qairtChatBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  check('QAIRT warmup and the following request share load parameters', () => {
    assert.deepEqual(loadFieldsOf(qairtWarmBody), loadFieldsOf(qairtChatBody))
    assert.equal(qairtWarmBody.spec_n_max, undefined)
  })

  const warm = (await callApi(ctx, 'warm', { model: 'org/qwen3.8-27b:Q4_0' })).body
  const ggufWarmBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  check('warmup uses the native GenieX warm-up shape', () => {
    assert.equal(warm.ok, true, JSON.stringify(warm))
    assert.equal(warm.value.warmed, true)
    assert.equal(ggufWarmBody.messages.length, 1)
    assert.equal(ggufWarmBody.messages[0].role, 'system')
    assert.equal(ggufWarmBody.enable_think, false)
    assert.equal(ggufWarmBody.max_completion_tokens, 1)
  })
  await callProxy(port, {
    model: 'org/qwen3.8-27b:Q4_0',
    messages: [{ role: 'user', content: 'after warm' }],
    stream: false,
  })
  const ggufChatBody = JSON.parse(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').at(-1).body)
  check('GGUF warmup and the following request share load parameters', () => {
    assert.deepEqual(loadFieldsOf(ggufWarmBody), loadFieldsOf(ggufChatBody))
    assert.equal(ggufWarmBody.spec_n_max, 3)
  })

  const status = (await callApi(ctx, 'modelStatus')).body.value
  check('status maps GenieX model state', () => {
    assert.equal(status.active, true)
    assert.deepEqual(status.models, ['org/qwen3.8-27b:Q4_0'])
    assert.equal(status.states['org/qwen3.8-27b:Q4_0'], 'active')
  })

  const stats = (await callApi(ctx, 'turnStats', { sessionId: 'missing', turn: 1 })).body.value
  check('unknown sessions have no turn stats', () => {
    assert.equal(stats, null)
  })

  const permission = (await callApi(ctx, 'permissionLabel', { locale: 'en' })).body.value
  check('a missing permission entry is tolerated', () => {
    assert.equal(permission.updated, false)
  })

  // ---- Toggle responsiveness -------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitForSync = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = (await callApi(ctx, 'state')).body.value
      if (current.pendingSync !== true) return current
      await sleep(100)
    }
    return (await callApi(ctx, 'state')).body.value
  }

  const offStarted = Date.now()
  const offState = (await callApi(ctx, 'setMode', { mode: 'off' })).body.value
  check('mode off answers immediately and removes the provider', () => {
    assert.ok(Date.now() - offStarted < 2000, 'mode off waited too long')
    assert.equal(offState.mode, 'off')
    assert.equal(ctx.config.providers['from-geniex'], undefined)
  })

  modelsGate = new Promise((resolve) => { releaseModels = resolve })
  const onStarted = Date.now()
  const onState = (await callApi(ctx, 'setMode', { mode: 'auto' })).body.value
  const onElapsed = Date.now() - onStarted
  check('mode on answers before discovery finishes', () => {
    assert.ok(onElapsed < 2000, `mode on took ${onElapsed}ms`)
    assert.equal(onState.mode, 'auto')
    assert.equal(onState.pendingSync, true)
  })
  releaseModels()
  modelsGate = null
  releaseModels = null
  const settled = await waitForSync()
  check('the background sync finishes and creates the provider', () => {
    assert.equal(settled.pendingSync, false)
    assert.equal(settled.provider.exists, true)
    assert.ok(ctx.config.providers['from-geniex'] !== undefined)
  })

  modelsGate = new Promise((resolve) => { releaseModels = resolve })
  await callApi(ctx, 'setMode', { mode: 'off' })
  const racing = (await callApi(ctx, 'setMode', { mode: 'auto' })).body.value
  const offWhileDiscovering = (await callApi(ctx, 'setMode', { mode: 'off' })).body.value
  check('switching off during discovery answers immediately', () => {
    assert.equal(racing.mode, 'auto')
    assert.equal(offWhileDiscovering.mode, 'off')
    assert.equal(ctx.config.providers['from-geniex'], undefined)
  })
  releaseModels()
  modelsGate = null
  releaseModels = null
  const afterRace = await waitForSync()
  check('an in-flight discovery cannot resurrect the provider after off', () => {
    assert.equal(afterRace.mode, 'off')
    assert.equal(afterRace.pendingSync, false)
    assert.equal(ctx.config.providers['from-geniex'], undefined)
  })

  // ---- QwenCloud --------------------------------------------------------
  const switched = (await callApi(ctx, 'save', {
    mode: 'auto',
    protocol: 'qwen',
    upstream: qwenURL,
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    contextWindow: null,
    maxOutputTokens: 8192,
    topK: 20,
    minP: 0.1,
  })).body
  assert.equal(switched.ok, true, JSON.stringify(switched))
  const qwenProvider = ctx.config.providers['from-qwencloud']
  check('switching source replaces the provider', () => {
    assert.equal(ctx.config.providers['from-geniex'], undefined)
    assert.ok(qwenProvider !== undefined)
    assert.equal(qwenProvider.apiKeyEnv, 'DASHSCOPE_API_KEY')
    assert.deepEqual(qwenProvider.models.map((model) => model.id).sort(), ['qwen3-coder-plus', 'qwen3-vl-plus', 'qwen3.6-plus', 'qwen3.8-max'])
    assert.equal(qwenRequests.some((request) => request.url === '/compatible-mode/v1/models'), false)
    assert.ok(qwenRequests.some((request) => request.url.startsWith('/api/v1/models')))
  })
  check('QwenCloud catalog carries context, output, vision, and reasoning', () => {
    const byId = new Map(qwenProvider.models.map((model) => [model.id, model]))
    assert.deepEqual(byId.get('qwen3.8-max').reasoningEfforts, { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' })
    assert.deepEqual(byId.get('qwen3.6-plus').reasoningEfforts, { off: null, max: 'enabled' })
    assert.equal(byId.get('qwen3-coder-plus').reasoningEfforts, false)
    assert.deepEqual(byId.get('qwen3-vl-plus').input, ['text', 'image'])
    assert.equal(byId.get('qwen3.8-max').contextWindow, 262144)
    assert.equal(byId.get('qwen3.8-max').maxTokens, 8192)
    assert.equal(byId.get('qwen3-vl-plus').contextWindow, 131072)
  })

  const qwenPort = switched.value.proxyPort
  const qwenSend = async (body) => {
    const response = await fetch(`http://127.0.0.1:${qwenPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text() }
  }
  const lastQwenBody = () => JSON.parse(qwenRequests.filter((request) => request.url.endsWith('/chat/completions')).at(-1).body)

  await qwenSend({ model: 'qwen3.8-max', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' })
  check('QwenCloud requests keep valid reasoning params only', () => {
    const body = lastQwenBody()
    assert.equal(body.enable_thinking, true)
    assert.equal(body.preserve_thinking, true)
    assert.equal(body.reasoning_effort, 'xhigh')
    assert.equal(body.min_p, undefined)
    assert.equal(body.top_k, 20)
    assert.equal(body.nctx, undefined)
    assert.equal(body.enable_think, undefined)
  })
  await qwenSend({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'enabled' })
  check('an on/off alias is dropped before Model Studio sees it', () => {
    const body = lastQwenBody()
    assert.equal(body.enable_thinking, true)
    assert.equal(body.reasoning_effort, undefined)
  })
  await qwenSend({ model: 'qwen3.8-max', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'off' })
  check('off disables thinking and stops preserving history reasoning', () => {
    const body = lastQwenBody()
    assert.equal(body.enable_thinking, false)
    assert.equal(body.preserve_thinking, undefined)
  })
  await qwenSend({ model: 'qwen3-coder-plus', messages: [{ role: 'user', content: 'hi' }] })
  check('a non-reasoning model gets no thinking parameters', () => {
    const body = lastQwenBody()
    assert.equal(body.enable_thinking, undefined)
    assert.equal(body.preserve_thinking, undefined)
  })

  const cleared = (await callApi(ctx, 'remove')).body.value
  check('removing the provider clears its catalog', () => {
    assert.equal(ctx.config.providers['from-qwencloud'], undefined)
    assert.equal(cleared.provider, null)
  })

  await (await callApi(ctx, 'setMode', { mode: 'off' })).body
  check('mode off persists', () => {
    assert.equal(ctx.config.providers['from-qwencloud'], undefined)
  })

  for (const disposer of ctx.effects.reverse()) {
    try {
      await disposer()
    } catch {
      // Individual disposer failures are not this test's subject.
    }
  }
} finally {
  releaseModels?.()
  await new Promise((resolve) => upstream.close(() => resolve()))
  await new Promise((resolve) => qwen.close(() => resolve()))
  process.env.PATH = savedEnv.PATH
  if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedEnv.USERPROFILE
  if (savedEnv.HOME === undefined) delete process.env.HOME
  else process.env.HOME = savedEnv.HOME
  if (savedEnv.DSH_PROFILE_DIR === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = savedEnv.DSH_PROFILE_DIR
  await rm(root, { recursive: true, force: true })
}

console.log(results.join('\n'))
