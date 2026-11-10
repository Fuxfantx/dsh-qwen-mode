/**
 * Model capability resolution for Qwen mode providers.
 *
 * GenieX caches a `geniex.json` manifest and the GGUF weights next to each
 * other, so context length, vision support, MTP drafts, sampling
 * recommendations, and thinking levels are all local facts. The HTTP detail
 * endpoint is only a fallback: it answers from the model currently loaded and
 * blocks behind GenieX's request GIL, which made a provider rebuild with a
 * large catalog both slow and fragile.
 *
 * @module dsh-qwen-mode/lib/capabilities
 */

import { execFile } from 'node:child_process'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readGgufHeader, reasoningEffortsFromChatTemplate } from './gguf.js'
import { isSafeRelativePath, isSafeSegment, positiveIntOrNull, splitModelId, trimMap } from './util.js'

/** Capability entries stay warm for one model-generation window. */
const CAPABILITY_TTL_MS = 5 * 60 * 1000
/** A failed lookup is retried soon instead of being cached for the full window. */
const FAILURE_TTL_MS = 15 * 1000
const CAPABILITY_LIMIT = 512
const CATALOG_TTL_MS = 60 * 1000
const CATALOG_RETRY_MS = 10 * 1000
const QWEN_CATALOG_TTL_MS = 5 * 60 * 1000
/** One catalog walk must not hold a provider sync open indefinitely. */
const QWEN_CATALOG_BUDGET_MS = 20 * 1000
const CLI_TIMEOUT_MS = 5000
const CLI_MAX_BUFFER = 8 * 1024 * 1024
const DETAIL_TIMEOUT_MS = 2500
const CATALOG_TIMEOUT_MS = 8000
const QWEN_CATALOG_PAGE_SIZE = 100
const QWEN_CATALOG_PAGES = 10
const VISION_MODEL_PATTERN = /(?:^|[/_.-])(?:vl|vision)(?:$|[/_.:-])/iu

/** The reasoning levels Qwen3.8 documents; used by the template-free fallback. */
const QWEN_38_LEVELS = { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' }
const QWEN_TOGGLE_LEVELS = { off: null, max: 'enabled' }

/**
 * Name-based thinking capabilities for families whose cache cannot answer.
 * Order matters: the first match wins, so the non-thinking exclusions and the
 * thinking-only models come first. A GGUF chat template always wins.
 */
const KNOWN_REASONING_EFFORTS = [
  { match: '-coder', efforts: false },
  // Thinking-only Qwen3.8 open-source model: it always reasons, so "off" must
  // not be offered (an absent level is unsupported; a null value means "no wire
  // parameter", which still means thinking is on).
  { match: 'qwen3.8-2.4t-a95b', efforts: { low: 'low', medium: 'medium', xhigh: 'xhigh' } },
  // Thinking-only Qwen3.7 snapshots.
  { match: 'qwen3.7-max-preview', efforts: { max: 'enabled' } },
  { match: 'qwen3.7-max-2026-05-17', efforts: { max: 'enabled' } },
  { match: '3.8', efforts: QWEN_38_LEVELS },
  { match: 'qwen3.7', efforts: QWEN_TOGGLE_LEVELS },
  { match: 'qwen3.6', efforts: QWEN_TOGGLE_LEVELS },
  { match: 'qwen3.5', efforts: QWEN_TOGGLE_LEVELS },
  { match: 'qwen3', efforts: QWEN_TOGGLE_LEVELS },
]

/**
 * Models that read historical `reasoning_content` only when
 * `preserve_thinking` is enabled. Model Studio documents an explicit list;
 * enabling it on any other model is unsupported, so a name check is the only
 * signal available from the catalog.
 */
const PRESERVE_THINKING_PATTERN = /(?:^|[/])(?:qwen3\.8-(?:max|flash|omni-flash)|qwen3\.7-(?:max|plus|flash)|qwen3\.6-(?:plus|flash)|kimi-k2\.(?:6|7-code))(?:$|[-.:/])/iu

/**
 * The thinking levels a model family is known to accept.
 * @param id - model id.
 * @returns a `reasoningEfforts` value, explicit `false`, or undefined.
 */
export function knownReasoningEfforts(id) {
  const name = id.toLowerCase()
  return KNOWN_REASONING_EFFORTS.find((entry) => name.includes(entry.match))?.efforts
}

/** Whether a model accepts `preserve_thinking` for historical reasoning. */
export function supportsPreserveThinking(id) {
  return typeof id === 'string' && PRESERVE_THINKING_PATTERN.test(id)
}

/** Whether a model name looks like a vision model. */
export function looksLikeVisionModel(id) {
  return VISION_MODEL_PATTERN.test(id)
}

/** Run the GenieX CLI, returning stdout. */
function runCli(args) {
  return new Promise((resolve, reject) => {
    const candidates = process.platform === 'win32' ? ['geniex.exe', 'geniex'] : ['geniex']
    const attempt = (index) => {
      if (index >= candidates.length) {
        reject(new Error('geniex CLI not found'))
        return
      }
      execFile(candidates[index], args, { windowsHide: true, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER }, (error, stdout) => {
        if (error === null) resolve(String(stdout))
        else attempt(index + 1)
      })
    }
    attempt(0)
  })
}

/** Parse `geniex list --format json` into name-keyed metadata. */
function parseCatalogJson(raw) {
  const models = new Map()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return models
  }
  if (!Array.isArray(parsed)) return models
  for (const row of parsed) {
    const name = typeof row?.name === 'string' ? row.name : ''
    if (name === '') continue
    models.set(name, {
      runtime: typeof row?.runtime === 'string' ? row.runtime : '',
      type: typeof row?.type === 'string' ? row.type.toLowerCase() : '',
    })
  }
  return models
}

/** Read the local model root printed by `geniex list`. */
function parseModelsRoot(raw) {
  const match = /Models cached in\s+(.+)/iu.exec(raw)
  if (match === null) return ''
  return match[1].replace(/\x1b\[[0-9;]*m/gu, '').trim()
}

function fallbackModelsRoot() {
  return join(homedir(), '.cache', 'geniex', 'models')
}

/** Create the capability resolver. */
export function createCapabilityResolver({ authHeaders, logger } = {}) {
  const cache = new Map()
  let catalogState = { key: '', value: null, at: 0, retryAt: 0, pending: null, pendingKey: '', generation: 0 }
  let qwenCatalogState = { key: '', value: null, at: 0, retryAt: 0, pending: null, pendingKey: '', generation: 0 }

  const cliCatalog = async () => {
    // The human-readable table is the only place the cache root is printed, and
    // the JSON form is the stable schema; a host without the CLI still works
    // from the default cache root.
    const [rootRaw, jsonRaw] = await Promise.all([
      runCli(['list']).catch(() => null),
      runCli(['list', '--format', 'json']).catch(() => null),
    ])
    return {
      root: parseModelsRoot(rootRaw ?? '') || fallbackModelsRoot(),
      models: parseCatalogJson(jsonRaw ?? ''),
      available: rootRaw !== null || jsonRaw !== null,
    }
  }

  const catalog = async (settings) => {
    if (settings.protocol !== 'geniex') return { root: '', models: new Map() }
    const now = Date.now()
    if (catalogState.value !== null && catalogState.key === settings.upstream) {
      if (now < catalogState.retryAt) return catalogState.value
      if (now - catalogState.at < CATALOG_TTL_MS) return catalogState.value
    }
    if (catalogState.pending !== null && catalogState.pendingKey === settings.upstream) return catalogState.pending

    const generation = catalogState.generation
    let pending
    pending = cliCatalog()
      .then((value) => {
        if (value.available !== true) {
          logger?.debug?.('[qwen-mode] geniex CLI unavailable; using the default model cache root')
        }
        if (catalogState.pending === pending && catalogState.generation === generation) {
          catalogState = {
            key: settings.upstream,
            value: { root: value.root, models: value.models },
            at: value.available === true ? Date.now() : 0,
            retryAt: value.available === true ? 0 : Date.now() + CATALOG_RETRY_MS,
            pending: null,
            pendingKey: '',
            generation,
          }
        }
        return { root: value.root, models: value.models }
      })
    catalogState = { ...catalogState, pending, pendingKey: settings.upstream }
    return pending
  }

  /** Read `geniex.json`, tolerating a missing or partial cache entry. */
  const readManifest = async (root, id) => {
    const { owner, leaf } = splitModelId(id)
    if (!isSafeSegment(leaf) || (owner !== '' && !isSafeSegment(owner))) return null
    const directory = owner === '' ? join(root, leaf) : join(root, owner, leaf)
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'geniex.json'), 'utf8'))
      return { directory, manifest }
    } catch {
      return null
    }
  }

  /** Pick the GGUF file for the request's precision, else a downloaded one. */
  const modelFile = (manifest, precision) => {
    const files = manifest?.ModelFile
    if (files === null || typeof files !== 'object') return ''
    const entries = Object.entries(files)
    const requested = precision === ''
      ? undefined
      : entries.find(([key]) => key.toLowerCase() === precision.toLowerCase())?.[1]
    const named = typeof requested?.Name === 'string' ? requested.Name : ''
    if (requested?.Downloaded === true && named !== '' && isSafeRelativePath(named)) return named
    for (const [, entry] of entries) {
      if (entry?.Downloaded === true && typeof entry?.Name === 'string' && isSafeRelativePath(entry.Name)) return entry.Name
    }
    return ''
  }

  /** Read the target GGUF header and the optional MTP sidecar. */
  const readWeights = async (directory, file, precision) => {
    const path = join(directory, file)
    let fileSize
    try {
      fileSize = (await stat(path)).size
    } catch {
      return null
    }
    const handle = await open(path, 'r')
    let header
    try {
      header = await readGgufHeader(handle, fileSize)
    } finally {
      await handle.close()
    }
    let sidecar = ''
    try {
      const names = await readdir(directory)
      const candidates = names
        .filter((name) => name !== file && /^mtp.*\.gguf$/iu.test(name))
        .sort()
      // Several precisions may each ship their own draft file; prefer the one
      // named after this request's precision.
      const chosen = (precision === ''
        ? undefined
        : candidates.find((name) => name.toLowerCase().includes(precision.toLowerCase())))
        ?? candidates[0]
      if (chosen !== undefined) sidecar = join(directory, chosen)
    } catch {
      // The optional MTP companion is absent.
    }
    return { header, sidecar }
  }

  /** Ask the upstream detail endpoint whether the model is a VLM. */
  const detailVision = async (settings, id) => {
    const base = new URL(settings.upstream)
    let pathname = base.pathname.replace(/\/+$/u, '')
    if (!pathname.endsWith('/v1')) pathname += '/v1'
    const segments = id.split('/').map(encodeURIComponent)
    const url = new URL(`${base.origin}${pathname}/models/${segments.join('/')}`)
    const headers = { accept: 'application/json' }
    if (typeof authHeaders === 'function') Object.assign(headers, await authHeaders(settings))
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS) })
    if (!response.ok) return null
    const detail = await response.json()
    return typeof detail?.model_type === 'string' ? detail.model_type.toLowerCase() === 'vlm' : null
  }

  /** Candidate model-list endpoints for a QwenCloud compatible base URL. */
  function qwenCatalogURLs(upstream) {
    const base = new URL(upstream)
    const path = base.pathname.replace(/\/+$/u, '')
    const urls = []
    // Model Studio publishes its catalog under /api/v1/models, while the chat
    // endpoint lives under /compatible-mode/v1. Plain OpenAI-compatible
    // gateways keep the standard <base>/models.
    const marker = path.lastIndexOf('/compatible-mode')
    if (marker !== -1) urls.push(`${base.origin}${path.slice(0, marker)}/api/v1/models`)
    urls.push(`${base.origin}${path}/models`)
    return [...new Set(urls)]
  }

  /** Normalize one catalog row into the fields the plugin needs. */
  function qwenRowCapability(row) {
    const id = typeof row?.model === 'string' ? row.model : typeof row?.id === 'string' ? row.id : ''
    if (id === '') return null
    const request = Array.isArray(row?.inference_metadata?.request_modality)
      ? row.inference_metadata.request_modality.map((value) => String(value).toLowerCase())
      : null
    const response = Array.isArray(row?.inference_metadata?.response_modality)
      ? row.inference_metadata.response_modality.map((value) => String(value).toLowerCase())
      : null
    // Image/audio generation models are listed too; they cannot serve chat.
    if (response !== null && !response.includes('text')) return null
    const declared = Array.isArray(row?.capabilities) ? row.capabilities.map((value) => String(value).toLowerCase()) : null
    if (declared !== null && !declared.includes('tg') && !declared.includes('reasoning')) return null
    return {
      id,
      vision: request !== null ? request.includes('image') : looksLikeVisionModel(id),
      contextLength: positiveIntOrNull(row?.model_info?.context_window),
      maxOutput: positiveIntOrNull(row?.model_info?.max_output_tokens),
      reasoning: declared === null ? undefined : declared.includes('reasoning'),
    }
  }

  /**
   * One catalog page, retried once for transient failures. A 404 means the
   * endpoint variant is unavailable and is not retried.
   */
  const fetchQwenPage = async (endpoint, page, filtered, headers) => {
    for (let attempt = 0; ; attempt += 1) {
      const url = new URL(endpoint)
      url.searchParams.set('page_no', String(page))
      url.searchParams.set('page_size', String(QWEN_CATALOG_PAGE_SIZE))
      // OR semantics: text-generation or reasoning models.
      if (filtered) {
        url.searchParams.append('capabilities', 'TG')
        url.searchParams.append('capabilities', 'Reasoning')
      }
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
        if (response.status === 404) return null
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } catch (error) {
        if (attempt === 1) throw error
      }
    }
  }

  /** Fetch one catalog endpoint; null means this variant is unavailable. */
  const fetchQwenCatalog = async (settings, endpoint) => {
    const headers = { accept: 'application/json' }
    if (typeof authHeaders === 'function') Object.assign(headers, await authHeaders(settings))
    for (const filtered of [true, false]) {
      const models = new Map()
      let total = null
      for (let page = 1; page <= QWEN_CATALOG_PAGES; page += 1) {
        let body
        try {
          body = await fetchQwenPage(endpoint, page, filtered, headers)
        } catch {
          // Keep whatever earlier pages produced; a later page failing is not
          // a reason to throw away a usable catalog.
          break
        }
        if (body === null) break
        const rows = Array.isArray(body?.output?.models)
          ? body.output.models
          : Array.isArray(body?.data)
            ? body.data
            : []
        for (const row of rows) {
          const entry = qwenRowCapability(row)
          if (entry !== null) models.set(entry.id, entry)
        }
        total = Number(body?.output?.total)
        if (rows.length === 0) break
        // A page may contain only models this provider cannot serve; keep
        // paging while the server reports more rows.
        if (Number.isFinite(total) && page * QWEN_CATALOG_PAGE_SIZE >= total) break
        if (!Number.isFinite(total) && rows.length < QWEN_CATALOG_PAGE_SIZE) break
      }
      if (models.size > 0) return models
    }
    return null
  }

  /** Cached QwenCloud model catalog; empty when the deployment has none. */
  const qwenCatalog = async (settings) => {
    const now = Date.now()
    if (qwenCatalogState.key === settings.upstream && qwenCatalogState.value !== null) {
      const ttl = qwenCatalogState.value.size > 0 ? QWEN_CATALOG_TTL_MS : CATALOG_RETRY_MS
      if (now < qwenCatalogState.retryAt || now - qwenCatalogState.at < ttl) return qwenCatalogState.value
    }
    if (qwenCatalogState.pending !== null && qwenCatalogState.pendingKey === settings.upstream) return qwenCatalogState.pending

    const generation = qwenCatalogState.generation
    const previous = qwenCatalogState.key === settings.upstream && (qwenCatalogState.value?.size ?? 0) > 0
      ? qwenCatalogState.value
      : null
    let pending
    let timer = null
    const work = (async () => {
      for (const endpoint of qwenCatalogURLs(settings.upstream)) {
        const models = await fetchQwenCatalog(settings, endpoint)
        if (models !== null && models.size > 0) return models
      }
      return new Map()
    })()
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(new Map()), QWEN_CATALOG_BUDGET_MS)
    })
    pending = Promise.race([work, timeout])
      .catch((error) => {
        logger?.debug?.(`[qwen-mode] QwenCloud catalog unavailable: ${String(error)}`)
        return previous ?? new Map()
      })
      .then((value) => {
        if (qwenCatalogState.pending === pending && qwenCatalogState.generation === generation) {
          qwenCatalogState = {
            key: settings.upstream,
            value,
            at: Date.now(),
            retryAt: value.size > 0 ? 0 : Date.now() + CATALOG_RETRY_MS,
            pending: null,
            pendingKey: '',
            generation,
          }
        }
        return value
      })
      .finally(() => {
        if (timer !== null) clearTimeout(timer)
      })
    qwenCatalogState = { ...qwenCatalogState, pending, pendingKey: settings.upstream }
    return pending
  }

  /** Build one QwenCloud capability from its catalog row. */
  const qwenCapabilities = (id, entry) => {
    const known = knownReasoningEfforts(id)
    let reasoningEfforts
    if (entry?.reasoning === false || known === false) reasoningEfforts = false
    else if (entry?.reasoning === true) reasoningEfforts = known ?? { off: null, max: 'enabled' }
    else reasoningEfforts = known
    return {
      vision: entry?.vision ?? looksLikeVisionModel(id),
      reasoningEfforts,
      contextLength: entry?.contextLength ?? null,
      maxOutput: entry?.maxOutput ?? null,
      runtime: 'qwen',
      hasMtp: false,
      mtpDraft: null,
      mtpReady: false,
      abliterated: false,
      tags: [],
      sampling: {},
    }
  }

  const geniexCapabilities = async (settings, id) => {
    const { root, models } = await catalog(settings)
    const { precision, name } = splitModelId(id)
    const entry = models.get(name)
    const manifestEntry = await readManifest(root, id)
    const manifest = manifestEntry?.manifest ?? null
    const declaredType = typeof manifest?.ModelType === 'string' ? manifest.ModelType.toLowerCase() : entry?.type ?? ''
    const runtime = typeof manifest?.PluginId === 'string' && manifest.PluginId !== '' ? manifest.PluginId : entry?.runtime ?? ''

    let header = null
    let sidecar = ''
    if (manifestEntry !== null) {
      const file = modelFile(manifest, precision)
      // QAIRT weights are compiled bundles, not GGUF files; reading them as
      // GGUF only wastes I/O and logs a parse failure per model.
      if (file !== '' && (runtime === 'llama_cpp' || /\.gguf$/iu.test(file))) {
        try {
          const weights = await readWeights(manifestEntry.directory, file, precision)
          if (weights !== null) {
            header = weights.header
            sidecar = weights.sidecar
          }
        } catch (error) {
          logger?.debug?.(`[qwen-mode] cannot read ${id}: ${String(error)}`)
        }
      }
    }

    let vision
    if (declaredType !== '') vision = declaredType === 'vlm'
    else if (manifest?.MMProjFile?.Downloaded === true) vision = true
    else {
      try {
        const detail = await detailVision(settings, id)
        vision = detail ?? looksLikeVisionModel(id)
      } catch {
        vision = looksLikeVisionModel(id)
      }
    }

    const fromTemplate = reasoningEffortsFromChatTemplate(header?.chatTemplate ?? '')
    const known = knownReasoningEfforts(id)
    // llama.cpp MTP needs both the model's own prediction heads and a draft
    // `mtp-*.gguf` injected into the model directory; the request then names
    // that file path as `spec_draft_model` (GenieX's `--draft-model`). GenieX
    // ignores speculative decoding for every other runtime.
    const tensorMtp = header?.hasMtp === true
    const draft = runtime === 'llama_cpp' && tensorMtp ? sidecar : ''
    return {
      vision,
      reasoningEfforts: fromTemplate ?? known,
      contextLength: positiveIntOrNull(header?.contextLength),
      maxOutput: null,
      runtime,
      hasMtp: tensorMtp,
      mtpDraft: draft === '' ? null : draft,
      mtpReady: draft !== '',
      abliterated: header?.abliterated === true,
      tags: header?.tags ?? [],
      sampling: header?.sampling ?? {},
    }
  }

  return {
    /**
     * Resolve one model's capabilities, cached for {@link CAPABILITY_TTL_MS}.
     * @param settings - current settings snapshot.
     * @param id - exact model id.
     * @param fresh - bypass a cached value (used after the user pulls a model).
     */
    async resolve(settings, id, fresh = false) {
      const key = `${settings.protocol}|${settings.upstream}|${id}`
      const cached = cache.get(key)
      if (!fresh && cached !== undefined) {
        const ttl = cached.value === null ? FAILURE_TTL_MS : CAPABILITY_TTL_MS
        if (Date.now() - cached.at < ttl) return cached.value
      }
      let value = null
      try {
        if (settings.protocol === 'geniex') {
          value = await geniexCapabilities(settings, id)
        } else {
          value = qwenCapabilities(id, (await qwenCatalog(settings)).get(id))
        }
      } catch (error) {
        logger?.debug?.(`[qwen-mode] capability lookup failed for ${id}: ${String(error)}`)
        value = null
      }
      cache.set(key, { value, at: Date.now() })
      trimMap(cache, CAPABILITY_LIMIT)
      return value
    },
    /**
     * List the QwenCloud chat catalog with fully resolved capabilities.
     * An empty map means the deployment exposes no catalog endpoint; callers
     * then fall back to the standard `/models` listing.
     */
    async listQwenModels(settings) {
      const catalog = await qwenCatalog(settings)
      const result = new Map()
      for (const [id, entry] of catalog) result.set(id, qwenCapabilities(id, entry))
      return result
    },
    /** Drop cached capabilities, optionally only those of one upstream. */
    invalidate(upstream) {
      if (upstream === undefined) {
        cache.clear()
        catalogState = { key: '', value: null, at: 0, retryAt: 0, pending: null, pendingKey: '', generation: catalogState.generation + 1 }
        qwenCatalogState = { key: '', value: null, at: 0, retryAt: 0, pending: null, pendingKey: '', generation: qwenCatalogState.generation + 1 }
        return
      }
      for (const key of [...cache.keys()]) {
        if (key.includes(`|${upstream}|`)) cache.delete(key)
      }
      if (catalogState.key === upstream) {
        catalogState = { ...catalogState, value: null, at: 0, retryAt: 0, pending: null, pendingKey: '', generation: catalogState.generation + 1 }
      }
      if (qwenCatalogState.key === upstream) {
        qwenCatalogState = { ...qwenCatalogState, value: null, at: 0, retryAt: 0, pending: null, pendingKey: '', generation: qwenCatalogState.generation + 1 }
      }
    },
  }
}
