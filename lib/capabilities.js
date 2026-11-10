/**
 * Model capability resolution for Qwen mode providers.
 *
 * GenieX caches a `geniex.json` manifest and the GGUF weights next to each
 * other, so context length, vision support, MTP drafts, sampling
 * recommendations, and thinking levels are all local facts. The HTTP detail
 * endpoint is only a fallback: it answers from the model currently loaded and
 * can block behind GenieX's request GIL, which made a provider rebuild with a
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
const CAPABILITY_LIMIT = 512
const CATALOG_TTL_MS = 60 * 1000
const CATALOG_RETRY_MS = 10 * 1000
const QWEN_CATALOG_TTL_MS = 5 * 60 * 1000
const CLI_TIMEOUT_MS = 5000
const CLI_MAX_BUFFER = 8 * 1024 * 1024
const DETAIL_TIMEOUT_MS = 5000
const CATALOG_TIMEOUT_MS = 8000
const QWEN_CATALOG_PAGE_SIZE = 100
const QWEN_CATALOG_PAGES = 10
const VISION_MODEL_PATTERN = /(?:^|[/_.-])(?:vl|vision)(?:$|[/_.:-])/iu
const ASSISTANT_MARKER = 'assistant'
const TOKEN_SPLIT = /[^a-z0-9]+/u

/**
 * Name-based thinking capabilities for families whose cache cannot answer.
 * Order matters: the first match wins, so the non-thinking exclusions come
 * first. These are only a fallback; a GGUF chat template always wins.
 */
const KNOWN_REASONING_EFFORTS = [
  { match: '-coder', efforts: false },
  { match: '3.6-35b-a3b', efforts: { off: null, max: 'enabled' } },
  { match: '3.8', efforts: { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' } },
  { match: 'qwen3.7', efforts: { off: null, max: 'enabled' } },
  { match: 'qwen3.6', efforts: { off: null, max: 'enabled' } },
  { match: 'qwen3.5', efforts: { off: null, max: 'enabled' } },
  { match: 'qwen3', efforts: { off: null, max: 'enabled' } },
]

/**
 * The thinking levels a model family is known to accept.
 * @param id - model id.
 * @returns a `reasoningEfforts` value, explicit `false`, or undefined.
 */
export function knownReasoningEfforts(id) {
  const name = id.toLowerCase()
  return KNOWN_REASONING_EFFORTS.find((entry) => name.includes(entry.match))?.efforts
}

/** Whether a model name looks like a vision model. */
export function looksLikeVisionModel(id) {
  return VISION_MODEL_PATTERN.test(id)
}

/** The precision suffix of a model id, lowercased. */
function precisionOf(id) {
  const colon = id.lastIndexOf(':')
  return colon === -1 ? '' : id.slice(colon + 1).toLowerCase()
}

/** Meaningful name tokens of a model id, without owner or precision. */
function nameTokens(id) {
  const { leaf } = splitModelId(id)
  return new Set(leaf.toLowerCase().split(TOKEN_SPLIT).filter((token) => token !== ''))
}

/**
 * Pair a QAIRT model with its separately cached `*-assistant*` companion.
 *
 * Only QAIRT models use this path: a GGUF model uses an `mtp-*.gguf` file in
 * its own directory (see {@link geniexCapabilities}). A companion is recognized
 * when its name carries the `assistant` token and contains every token of the
 * target's name, so unrelated `*-assistant` models are left alone.
 *
 * @param ids - model ids to consider; callers pass QAIRT models only.
 * @returns assistant id to target id.
 */
export function pairAssistantDrafts(ids) {
  const drafts = []
  const targets = []
  for (const id of ids) {
    const tokens = nameTokens(id)
    if (tokens.size === 0) continue
    if (tokens.has(ASSISTANT_MARKER)) drafts.push({ id, tokens })
    else targets.push({ id, tokens })
  }
  const candidates = new Map()
  for (const draft of drafts) {
    let best = null
    for (const target of targets) {
      if (draft.tokens.size <= target.tokens.size) continue
      let containsAll = true
      for (const token of target.tokens) {
        if (!draft.tokens.has(token)) {
          containsAll = false
          break
        }
      }
      if (!containsAll) continue
      if (best === null || target.tokens.size > best.tokens.size) best = target
    }
    if (best === null) continue
    const list = candidates.get(best.id) ?? []
    list.push(draft.id)
    candidates.set(best.id, list)
  }
  const pairs = new Map()
  for (const [targetId, draftIds] of candidates) {
    const precision = precisionOf(targetId)
    const chosen = draftIds.find((id) => precisionOf(id) === precision) ?? draftIds[0]
    pairs.set(chosen, targetId)
  }
  return pairs
}

/**
 * Pair the QAIRT subset of an advertised catalog.
 * @param ids - every advertised model id.
 * @param capabilities - resolved capabilities per id.
 * @returns assistant id to QAIRT target id.
 */
export function pairQairtDrafts(ids, capabilities) {
  const qairt = ids.filter((id) => capabilities.get(id)?.runtime === 'qairt')
  return pairAssistantDrafts(qairt)
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
      precisions: Array.isArray(row?.precisions) ? row.precisions.filter((value) => typeof value === 'string') : [],
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

/**
 * Create the capability resolver.
 *
 * @param options.authHeaders - resolves the upstream credential header for a
 *   settings snapshot (used only by the HTTP detail fallback).
 * @param options.logger - optional logger for contained failures.
 */
export function createCapabilityResolver({ authHeaders, logger } = {}) {
  const cache = new Map()
  let catalogState = { key: '', value: null, at: 0, retryAt: 0, pending: null }
  let qwenCatalogState = { key: '', value: null, at: 0, retryAt: 0, pending: null }

  const cliCatalog = async () => {
    const [rootRaw, jsonRaw] = await Promise.all([
      runCli(['list']).catch(() => ''),
      runCli(['list', '--format', 'json']).catch(() => ''),
    ])
    const root = parseModelsRoot(rootRaw) || join(homedir(), '.cache', 'geniex', 'models')
    return { root, models: parseCatalogJson(jsonRaw) }
  }

  const catalog = async (settings) => {
    if (settings.protocol !== 'geniex') return { root: '', models: new Map() }
    const now = Date.now()
    if (catalogState.value !== null && catalogState.key === settings.upstream && now - catalogState.at < CATALOG_TTL_MS) {
      return catalogState.value
    }
    if (catalogState.pending !== null) return catalogState.pending
    if (now < catalogState.retryAt) return catalogState.value ?? { root: '', models: new Map() }
    const pending = cliCatalog()
      .catch((error) => {
        logger?.debug?.(`[qwen-mode] geniex catalog unavailable: ${String(error)}`)
        catalogState.retryAt = Date.now() + CATALOG_RETRY_MS
        return { root: join(homedir(), '.cache', 'geniex', 'models'), models: new Map() }
      })
      .then((value) => {
        catalogState = { key: settings.upstream, value, at: Date.now(), retryAt: 0, pending: null }
        return value
      })
    catalogState = { ...catalogState, pending }
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
    const requested = precision === '' ? undefined : files[precision]
    const named = typeof requested?.Name === 'string' ? requested.Name : ''
    if (named !== '' && isSafeRelativePath(named)) return named
    for (const entry of Object.values(files)) {
      if (entry?.Downloaded === true && typeof entry?.Name === 'string' && isSafeRelativePath(entry.Name)) return entry.Name
    }
    return ''
  }

  /** Read the target GGUF header and the optional MTP sidecar. */
  const readWeights = async (directory, file) => {
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
      const candidate = names
        .filter((name) => name !== file && /^mtp.*\.gguf$/iu.test(name))
        .sort()[0]
      if (candidate !== undefined) sidecar = join(directory, candidate)
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
    const marker = path.lastIndexOf('/compatible-mode/')
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

  /** Fetch one catalog endpoint; null means this variant is unavailable. */
  const fetchQwenCatalog = async (settings, endpoint) => {
    const headers = { accept: 'application/json' }
    if (typeof authHeaders === 'function') Object.assign(headers, await authHeaders(settings))
    for (const filtered of [true, false]) {
      const models = new Map()
      try {
        for (let page = 1; page <= QWEN_CATALOG_PAGES; page += 1) {
          const url = new URL(endpoint)
          url.searchParams.set('page_no', String(page))
          url.searchParams.set('page_size', String(QWEN_CATALOG_PAGE_SIZE))
          // OR semantics: text-generation or reasoning models.
          if (filtered) {
            url.searchParams.append('capabilities', 'TG')
            url.searchParams.append('capabilities', 'Reasoning')
          }
          const response = await fetch(url, { headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          const rows = Array.isArray(body?.output?.models)
            ? body.output.models
            : Array.isArray(body?.data)
              ? body.data
              : []
          const before = models.size
          for (const row of rows) {
            const entry = qwenRowCapability(row)
            if (entry !== null) models.set(entry.id, entry)
          }
          const total = Number(body?.output?.total)
          if (rows.length === 0 || models.size === before) break
          if (!Number.isFinite(total) || page * QWEN_CATALOG_PAGE_SIZE >= total) break
        }
        if (models.size > 0) return models
      } catch {
        // Try the next variant or endpoint.
      }
    }
    return null
  }

  /** Cached QwenCloud model catalog; empty when the deployment has none. */
  const qwenCatalog = async (settings) => {
    const now = Date.now()
    if (qwenCatalogState.value !== null && qwenCatalogState.key === settings.upstream && now - qwenCatalogState.at < QWEN_CATALOG_TTL_MS) {
      return qwenCatalogState.value
    }
    if (qwenCatalogState.pending !== null) return qwenCatalogState.pending
    if (now < qwenCatalogState.retryAt) return qwenCatalogState.value ?? new Map()
    const pending = (async () => {
      for (const endpoint of qwenCatalogURLs(settings.upstream)) {
        const models = await fetchQwenCatalog(settings, endpoint)
        if (models !== null && models.size > 0) return models
      }
      return new Map()
    })()
      .catch((error) => {
        logger?.debug?.(`[qwen-mode] QwenCloud catalog unavailable: ${String(error)}`)
        return qwenCatalogState.value ?? new Map()
      })
      .then((value) => {
        qwenCatalogState = {
          key: settings.upstream,
          value,
          at: Date.now(),
          retryAt: value.size > 0 ? 0 : Date.now() + CATALOG_RETRY_MS,
          pending: null,
        }
        return value
      })
    qwenCatalogState = { ...qwenCatalogState, key: settings.upstream, pending }
    return pending
  }

  /** Build one QwenCloud capability from its catalog row. */
  const qwenCapabilities = (id, entry) => {
    const known = knownReasoningEfforts(id)
    let reasoningEfforts
    if (entry?.reasoning === false) reasoningEfforts = false
    else if (entry?.reasoning === true) reasoningEfforts = known !== undefined && known !== false ? known : { off: null, max: 'enabled' }
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
      source: 'qwen',
    }
  }

  const geniexCapabilities = async (settings, id) => {
    const { root, models } = await catalog(settings)
    const { precision, name } = splitModelId(id)
    const entry = models.get(name)
    const manifestEntry = await readManifest(root, id)
    const manifest = manifestEntry?.manifest ?? null
    let header = null
    let sidecar = ''
    if (manifestEntry !== null) {
      const file = modelFile(manifest, precision)
      if (file !== '') {
        try {
          const weights = await readWeights(manifestEntry.directory, file)
          if (weights !== null) {
            header = weights.header
            sidecar = weights.sidecar
          }
        } catch (error) {
          logger?.debug?.(`[qwen-mode] cannot read ${id}: ${String(error)}`)
        }
      }
    }

    const declaredType = typeof manifest?.ModelType === 'string' ? manifest.ModelType.toLowerCase() : entry?.type ?? ''
    const runtime = typeof manifest?.PluginId === 'string' && manifest.PluginId !== '' ? manifest.PluginId : entry?.runtime ?? ''
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
    // that file path as `spec_draft_model` (GenieX's `--draft-model`).
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
      source: 'geniex',
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
      if (!fresh && cached !== undefined && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.value
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
        catalogState = { key: '', value: null, at: 0, retryAt: 0, pending: null }
        qwenCatalogState = { key: '', value: null, at: 0, retryAt: 0, pending: null }
        return
      }
      for (const key of [...cache.keys()]) {
        if (key.includes(`|${upstream}|`)) cache.delete(key)
      }
      if (catalogState.key === upstream) catalogState = { ...catalogState, value: null, at: 0 }
      if (qwenCatalogState.key === upstream) qwenCatalogState = { ...qwenCatalogState, value: null, at: 0 }
    },
  }
}
