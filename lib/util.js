/**
 * Small shared helpers for the Qwen mode host half.
 *
 * Everything here is dependency-free so the host can be reasoned about (and
 * unit-tested) without a Cordis context.
 *
 * @module dsh-qwen-mode/lib/util
 */

/** Trimmed string or the empty string. */
export function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** A finite number, or null. */
export function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A finite number clamped into [min, max], or null. */
export function clampedNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, value))
}

/** A positive integer, or the fallback. */
export function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** A positive integer, or null. */
export function positiveIntOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** An Error carrying an HTTP status. */
export function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** Wait for one timer period. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Write one JSON response, tolerating a client that already went away. */
export function sendJson(res, status, body) {
  if (res.writableEnded) return
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch {
    res.destroy()
  }
}

/**
 * Read and parse a JSON request body, rejecting oversized or malformed input.
 * A declared `content-length` above the limit is refused before buffering.
 * @param req - incoming request.
 * @param limit - maximum accepted body size in bytes.
 * @returns the parsed object; `{}` for an empty body.
 */
export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    const fail = (error) => {
      if (settled) return
      settled = true
      req.resume()
      reject(error)
    }
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      fail(httpError(413, 'request body is too large'))
      return
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        fail(httpError(413, 'request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
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
    req.on('error', fail)
    req.on('aborted', () => fail(httpError(400, 'request aborted')))
  })
}

/**
 * Run an async operation over `items` with at most `limit` in flight.
 * @returns results in input order.
 */
export async function mapLimit(items, limit, operation) {
  const results = new Array(items.length)
  const width = Math.max(1, Math.min(limit, items.length))
  let next = 0
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await operation(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** The model name without its provider owner and precision suffix. */
export function shortModelName(id) {
  const leaf = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return leaf.replace(/:[^:/]+$/u, '') || id
}

/**
 * Split a GenieX model id (`owner/leaf:PRECISION`) into cache-path segments.
 * A missing owner yields an empty owner, and a missing precision an empty one.
 * @returns owner, leaf, precision, and the precision-free name.
 */
export function splitModelId(id) {
  const colon = id.lastIndexOf(':')
  const name = colon === -1 ? id : id.slice(0, colon)
  const precision = colon === -1 ? '' : id.slice(colon + 1)
  const slash = name.indexOf('/')
  return {
    owner: slash === -1 ? '' : name.slice(0, slash),
    leaf: slash === -1 ? name : name.slice(slash + 1),
    precision,
    name,
  }
}

/** Whether a cache-path segment is safe to join under the model root. */
export function isSafeSegment(value) {
  return value !== '' && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\')
    && !value.includes('\0') && !value.includes(':')
}

/** Whether a relative path stays inside its base directory. */
export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.startsWith('\\')) return false
  return value.split(/[/\\]/u).every(isSafeSegment)
}

/** Drop the oldest entries of a Map (or Set) until it is at most `max` entries. */
export function trimMap(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

/**
 * A scoped logger with the same shape Cordis exposes.
 * @param ctx - plugin context.
 * @param scope - logger scope name.
 */
export function loggerFor(ctx, scope) {
  try {
    const scoped = ctx.logger?.(scope)
    if (scoped !== null && typeof scoped === 'object' && typeof scoped.info === 'function') return scoped
  } catch {
    // Fall back to the unscoped logger below.
  }
  const base = ctx.logger ?? {}
  return {
    info: (message) => base.info?.(message),
    warn: (message) => base.warn?.(message),
    error: (message) => base.error?.(message),
  }
}

/** The accepted proxy-auth credential reference grammar. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Whether `value` can name a DSH credential. */
export function isCredentialRef(value) {
  return CREDENTIAL_REF_PATTERN.test(value)
}

/**
 * Write one configuration entry outside an active HMR reload transaction.
 *
 * `ConfigEditor.edit` serializes through `hmr.runExclusive`, which rejects a
 * call made from inside a transaction. Plugin activation starts background
 * work whose async chain keeps the reload's AsyncLocalStorage context; the
 * first provider write would therefore fail with "HMR transactions cannot be
 * nested". Exiting that store lets the edit queue after the reload that
 * spawned it instead of nesting inside it.
 *
 * @param ctx - plugin context.
 * @param entry - config entry to edit.
 * @param change - edit callback passed to `ctx.configEditor.edit`.
 */
export async function runConfigEdit(ctx, entry, change) {
  const edit = () => ctx.configEditor.edit(entry, change)
  let hmr
  try {
    hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined
  } catch {
    hmr = undefined
  }
  const executing = hmr?.executing
  if (executing === undefined
    || typeof executing.getStore !== 'function'
    || typeof executing.exit !== 'function'
    || executing.getStore() === undefined) {
    return edit()
  }
  return executing.exit(edit)
}
