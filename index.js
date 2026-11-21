/**
 * Artifact timeline — Host half.
 *
 * Collects every file deliverable recorded across ALL conversations into one
 * time-ordered catalogue, marks the ones that were deleted or changed on disk
 * after they were produced, and serves the panel's actions: opening a file on
 * the Host desktop, revealing it in the file manager, and copying its path is
 * pure Client work.
 *
 * Sources, all read from the durable Session logs (the only source of truth):
 *
 *  - `deliverables/presented` — the `present` tool's own declarations, the
 *    authoritative "this is a deliverable" signal.
 *  - document-producing tool calls — `write` / `edit` / `str_replace_editor`
 *    plus the Univer export tools (`univer_export`, `univer_print_pdf`), whose
 *    explicit destination argument names the artifact. Production is confirmed
 *    by the matching successful `tool/result` (a failed call contributes
 *    nothing), and a successful result's canonical `meta.path` wins over the
 *    argument spelling.
 *  - shell commands (`pwsh` / `bash` / `node`) — scripts produce Office documents
 *    too. Candidate document paths are extracted from the command
 *    text and admitted only on disk evidence: the file exists and its mtime
 *    is at or after one of the calls that name it, so inputs, templates,
 *    typos, and failed commands stay out. Evidence-gated rows therefore never
 *    show a red "deleted" state — a vanished un-declared script output has no
 *    evidence left and is dropped.
 *  - `session/title` — the conversation label shown on each row's actions.
 *
 * Two independent caches keep this responsive:
 *
 *  - the event catalogue is keyed per Session on the persistence revision, so
 *    a warm request only re-reads Sessions that actually changed;
 *  - file status (stable / changed / missing) is a short-TTL `stat` cache, so
 *    a file edited on disk updates without re-reading a single event.
 *
 * The first scan after boot reads every log, so it runs in the background and
 * the route answers with whatever is already folded plus a progress frame.
 */

import { promises as fsp } from 'node:fs'
import { resolve as resolvePath, isAbsolute, basename, extname, dirname } from 'node:path'
import { homedir } from 'node:os'

/** Stable Loader identity. */
export const name = 'dsh-work-out'

/** Services required before mounting. `sessionController` owns native opens. */
export const inject = ['connection', 'sessionPersistence', 'sessionController', 'fs']

/** Upper bound on concurrently open Session read handles. */
const SCAN_CONCURRENCY = 4

/** Events per persistence page. */
const PAGE = 500

/** Tolerated clock skew between a delivery event and a file's mtime. */
const MTIME_TOLERANCE_MS = 2000

/** Cap on concurrent `stat` calls while resolving file status. */
const STAT_CONCURRENCY = 24

/** Extensions that count as a produced document rather than source code. */
const DOCUMENT_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rtf', 'log',
  'docx', 'doc', 'odt', 'pages',
  'pptx', 'ppt', 'odp', 'key',
  'xlsx', 'xls', 'ods', 'csv', 'tsv', 'numbers',
  'pdf', 'html', 'htm', 'epub',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'tiff',
  'mp4', 'mov', 'mp3', 'wav',
  'zip', 'rar', '7z', 'tar', 'gz',
  'tex', 'latex',
])

/**
 * Tools whose call names a produced file directly, and the argument keys that
 * may carry it. A candidate counts only when its extension is a document
 * type, so the .univer container of an export never registers as an artifact.
 * The office kit's convert/render tools write into a retained temporary store
 * under the harness home and are deliberately absent: the copies the model
 * later makes into the workspace surface as rows of their own.
 */
const WRITE_TOOLS = new Map([
  ['write', ['file_path']],
  ['edit', ['file_path']],
  ['str_replace_editor', ['path']],
  ['univer_export', ['output']],
  ['univer_print_pdf', ['output']],
])

/** Shell tools whose command text may name files a script produced. */
const COMMAND_TOOLS = new Map([
  ['pwsh', ['command']],
  ['bash', ['command']],
  ['node', ['code']],
])

/** Path shapes that are never user-facing artifacts, by marker. */
const EXCLUDED_MARKERS = [
  /[\\/]\.dsh[\\/]/i,
  /[\\/]\.dsh-[^\\/]*[\\/]/i,
  /[\\/]node_modules[\\/]/i,
  /[\\/]\.pnpm[\\/]/i,
  /[\\/]\.git[\\/]/i,
  /RECYCLER|RECYCLE\.BIN/i,
]

/** Temp roots from this process's environment (Windows TEMP, TMP). */
const tempRoots = [process.env.TEMP, process.env.TMP]
  .filter((value) => typeof value === 'string' && value.length > 0)
  .map((value) => value.replace(/[\\/]+$/, '').toLowerCase())

/** Whether an absolute path lies in harness-internal or scratch storage. */
function isExcludedPath(absolutePath) {
  if (EXCLUDED_MARKERS.some((marker) => marker.test(absolutePath))) return true
  const lower = absolutePath.toLowerCase()
  return tempRoots.some(
    (root) => lower === root || lower.startsWith(root + '\\') || lower.startsWith(root + '/'),
  )
}

/** Process-level cache key, so a fiber reload reuses one warm catalogue. */
const STORE_KEY = '__dshArtifactTimelineStore'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lowercase extension without the dot, empty when there is none. */
function extensionOf(path) {
  return extname(path).slice(1).toLowerCase()
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Resolve a recorded artifact path into an absolute Host path.
 * Absolute paths are kept; relative ones resolve against the Session `cwd`.
 */
function absoluteArtifactPath(recordedPath, cwd) {
  const path = nonBlank(recordedPath)
  if (path === undefined) return undefined
  if (isAbsolute(path)) return resolvePath(path)
  if (typeof cwd === 'string' && cwd.length > 0) return resolvePath(cwd, path)
  return resolvePath(homedir(), path)
}

/** True when the trailing extension is a document type. */
function isDocumentPath(path) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(path.trim())
  return match !== null && DOCUMENT_EXTENSIONS.has(match[1].toLowerCase())
}

/**
 * Extract the file path a document-producing `tool/call` targeted.
 *
 * For `write` / `edit` / `str_replace_editor` this mirrors the built-in
 * deliverables derivation (the same argument-shape validation), so both agree
 * on what counts as a produced file. For the Univer export tools it reads the
 * explicit destination. Anything not recognisably a production returns
 * undefined.
 */
function structuredPath(toolName, args) {
  if (!isRecord(args)) return undefined
  switch (toolName) {
    case 'write':
      if (typeof args.content !== 'string') return undefined
      break
    case 'edit':
      if (!(typeof args.old_string === 'string' && args.old_string.length > 0
        && typeof args.new_string === 'string' && args.old_string !== args.new_string)) return undefined
      break
    case 'str_replace_editor':
      // Only mutating commands with a complete payload produced anything.
      switch (args.command) {
        case 'create':
          if (typeof args.file_text !== 'string') return undefined
          break
        case 'str_replace':
          if (!(typeof args.old_str === 'string' && args.old_str.length > 0)) return undefined
          break
        case 'insert':
          if (!(Number.isInteger(args.insert_line) && args.insert_line >= 0
            && typeof args.new_str === 'string')) return undefined
          break
        default:
          return undefined
      }
      break
    default:
      break
  }
  for (const key of WRITE_TOOLS.get(toolName) ?? []) {
    const path = nonBlank(args[key])
    if (path !== undefined && isDocumentPath(path)) return path
  }
  return undefined
}

/**
 * Pull candidate file paths out of one shell command string.
 *
 * Quoted runs are captured whole (paths with spaces), then the remaining
 * text is split on shell word boundaries. A token counts when it ends in a
 * document extension and carries no wildcard, variable, or brace syntax —
 * those are patterns, not concrete files — and is not a URL or a flag. The
 * caller's disk-evidence gate (exists + mtime at or after a call naming it)
 * is what finally separates produced outputs from mentioned inputs.
 */
function commandPaths(commandText) {
  if (typeof commandText !== 'string' || commandText.length === 0) return []
  const out = []
  const seen = new Set()
  const push = (raw) => {
    let token = raw.trim().replace(/^['"`]+|['"`]+$/g, '').replace(/[),.;:!?'"`]+$/, '')
    if (token.length === 0) return
    if (!isDocumentPath(token)) return
    // Glob / variable / brace / substitution syntax: not a concrete path.
    if (/[*?$%{}[\]`]/.test(token)) return
    // A flag like `-x.docx` or a URL is not a path either.
    if (token.startsWith('-') || token.includes('://')) return
    const key = token.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(token)
  }

  const quoted = /"[^"]+"|'[^']+'/g
  let match
  let rest = ''
  let cursor = 0
  while ((match = quoted.exec(commandText)) !== null) {
    rest += commandText.slice(cursor, match.index)
    push(match[0])
    cursor = match.index + match[0].length
  }
  rest += commandText.slice(cursor)
  for (const token of rest.split(/[\s,;|&<>()=`\u0000-\u001f'"]+/)) push(token)
  return out
}

/**
 * Incremental fold of one Session's events into artifact rows.
 *
 * A `present` declaration wins over everything else for the same path;
 * repeated structured mutations of one undeclared path collapse onto the last
 * successful one, so a file edited across ten turns is one row, not ten.
 * Structured productions are confirmed by their `tool/result`: an erroring
 * result drops the candidate, and a canonical `meta.path` on a successful one
 * replaces the argument spelling. Shell candidates accumulate their
 * occurrences per path; the request-time evidence gate picks which occurrence
 * actually produced the file.
 */
class SessionFolder {
  constructor(header, includeWritten) {
    this.sessionId = header.id
    this.cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    this.createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0
    this.includeWritten = includeWritten
    /** Latest `session/title` event; the panel labels rows with it. */
    this.title = undefined
    /** Subagent logs are noted so the panel can label their origin honestly. */
    this.subagent = header.origin === 'subagent'
    /** @type {Map<string, object>} keyed on lowercase absolute path */
    this.declared = new Map()
    /** @type {Map<string, object>} confirmed structured productions */
    this.written = new Map()
    /** @type {Map<string, object>} structured calls awaiting their result */
    this.pending = new Map()
    /** @type {Map<string, object>} shell candidates, keyed on lowercase path */
    this.commands = new Map()
  }

  /** Fold one page of events; returns nothing, state accumulates. */
  absorb(events) {
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      const data = event.data
      if (!isRecord(data)) continue

      if (event.type === 'session/title') {
        if (typeof data.title === 'string' && data.title.trim().length > 0) this.title = data.title
        continue
      }

      if (event.type === 'deliverables/presented') {
        const files = Array.isArray(data.files) ? data.files : []
        const time = typeof event.time === 'number' ? event.time : this.createdAt
        const seq = typeof event.seq === 'number' ? event.seq : 0
        const turn = typeof data.turn === 'number' ? data.turn : undefined
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]
          if (!isRecord(file)) continue
          const absolute = absoluteArtifactPath(file.path, this.cwd)
          if (absolute === undefined || isExcludedPath(absolute)) continue
          // One present event declares several files under the SAME seq, so
          // rows carry a per-file id: open requests need one row, not "the
          // first row of this event". Written rows take the bare seq and
          // command rows a `c` prefix; present rids always carry '#'.
          this.declared.set(absolute.toLowerCase(), {
            sessionId: this.sessionId,
            rid: `${seq}#${index}`,
            path: absolute,
            name: basename(absolute),
            ext: extensionOf(absolute),
            ...(nonBlank(file.description) === undefined ? {} : { description: file.description }),
            ...(turn === undefined ? {} : { turn }),
            source: 'presented',
            time,
            seq,
          })
        }
        continue
      }

      if (!this.includeWritten) continue

      if (event.type === 'tool/call') {
        const time = typeof event.time === 'number' ? event.time : this.createdAt
        const seq = typeof event.seq === 'number' ? event.seq : 0
        const turn = typeof data.turn === 'number' ? data.turn : undefined
        const toolName = typeof data.name === 'string' ? data.name : ''

        if (WRITE_TOOLS.has(toolName)) {
          const callId = nonBlank(data.callId)
          if (callId === undefined) continue
          let args
          try { args = JSON.parse(data.arguments) } catch { continue }
          const raw = structuredPath(toolName, args)
          if (raw === undefined) continue
          const absolute = absoluteArtifactPath(raw, this.cwd)
          if (absolute === undefined || isExcludedPath(absolute)) continue
          this.pending.set(callId, {
            path: absolute,
            ...(turn === undefined ? {} : { turn }),
            instrument: toolName,
            time,
            seq,
          })
          continue
        }

        if (COMMAND_TOOLS.has(toolName)) {
          let args
          try { args = JSON.parse(data.arguments) } catch { continue }
          const found = []
          for (const key of COMMAND_TOOLS.get(toolName) ?? []) {
            for (const raw of commandPaths(isRecord(args) ? args[key] : undefined)) found.push(raw)
          }
          for (let index = 0; index < found.length; index += 1) {
            const absolute = absoluteArtifactPath(found[index], this.cwd)
            if (absolute === undefined || isExcludedPath(absolute)) continue
            const mapKey = absolute.toLowerCase()
            const existing = this.commands.get(mapKey)
            if (existing !== undefined) {
              existing.occurrences.push({ time, seq })
              continue
            }
            // One command may name several outputs under the same seq, so the
            // rid carries the per-call index: open requests need one row.
            this.commands.set(mapKey, {
              sessionId: this.sessionId,
              rid: `c${seq}#${index}`,
              path: absolute,
              name: basename(absolute),
              ext: extensionOf(absolute),
              ...(turn === undefined ? {} : { turn }),
              source: 'command',
              instrument: toolName,
              // Provisional; the evidence gate replaces this with the
              // credited occurrence's time at request time.
              time,
              seq,
              occurrences: [{ time, seq }],
            })
          }
        }
        continue
      }

      if (event.type === 'tool/result') {
        const message = isRecord(data.message) ? data.message : undefined
        const source = message !== undefined && isRecord(message.source) ? message.source : undefined
        const callId = source !== undefined ? nonBlank(source.callId) : undefined
        if (callId === undefined) continue
        const candidate = this.pending.get(callId)
        if (candidate === undefined) continue
        this.pending.delete(callId)
        // A failed call produced nothing; the built-in derivation agrees.
        if (message?.isError === true) continue
        // A canonical target reported by the tool wins over the argument.
        const meta = isRecord(data.meta) ? data.meta : undefined
        let absolute = candidate.path
        if (meta !== undefined && typeof meta.path === 'string' && isAbsolute(meta.path)) {
          absolute = resolvePath(meta.path)
        }
        if (isExcludedPath(absolute)) continue
        this.written.set(absolute.toLowerCase(), {
          sessionId: this.sessionId,
          rid: `${candidate.seq}`,
          path: absolute,
          name: basename(absolute),
          ext: extensionOf(absolute),
          ...(candidate.turn === undefined ? {} : { turn: candidate.turn }),
          source: 'written',
          instrument: candidate.instrument,
          time: candidate.time,
          seq: candidate.seq,
        })
      }
    }
  }

  /**
   * Folded rows, strongest source first: declared deliveries, confirmed
   * structured productions, calls still awaiting a result (a live tail),
   * then shell candidates no stronger signal already claims.
   */
  rows() {
    const out = [...this.declared.values()]
    const claimed = new Set(this.declared.keys())
    for (const [key, row] of this.written) {
      if (!claimed.has(key)) out.push(row)
    }
    for (const candidate of this.pending.values()) {
      const absolute = candidate.path
      const key = absolute.toLowerCase()
      if (claimed.has(key) || this.written.has(key)) continue
      out.push({
        sessionId: this.sessionId,
        rid: `${candidate.seq}`,
        path: absolute,
        name: basename(absolute),
        ext: extensionOf(absolute),
        ...(candidate.turn === undefined ? {} : { turn: candidate.turn }),
        source: 'written',
        instrument: candidate.instrument,
        time: candidate.time,
        seq: candidate.seq,
      })
    }
    for (const [key, row] of this.commands) {
      if (!claimed.has(key) && !this.written.has(key)) out.push(row)
    }
    return out
  }

  /** Session-level facts the panel labels rows and open actions with. */
  meta() {
    return {
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      ...(this.title === undefined ? {} : { title: this.title }),
      ...(this.subagent === true ? { subagent: true } : {}),
    }
  }
}

/** Read one Session's log page by page, folding as it goes. */
async function foldSession(persistence, header, includeWritten, signal) {
  const handle = await persistence.open(header.id, 'read', { signal })
  const folder = new SessionFolder(header, includeWritten)
  try {
    let offset = 0
    for (;;) {
      signal?.throwIfAborted()
      const slice = await handle.read(offset, PAGE, { signal })
      const page = isRecord(slice) && Array.isArray(slice.events) ? slice.events : []
      if (page.length === 0) break
      folder.absorb(page)
      offset += page.length
    }
    return { rows: folder.rows(), meta: folder.meta() }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * The catalogue: a per-Session cache keyed on the persistence revision, plus
 * a short-TTL filesystem status cache. Rows keep their fold shape (command
 * rows carry occurrences); the disk evidence is applied per request, so a
 * deletion or regeneration re-grades a command row without any re-read.
 */
class ArtifactStore {
  constructor() {
    /** @type {Map<string, {revision: unknown, rows: object[], meta: object}>} */
    this.sessions = new Map()
    /** @type {Map<string, {checkedAt: number, exists: boolean, mtimeMs?: number}>} */
    this.status = new Map()
    this.scanPromise = null
    this.scan = { running: false, total: 0, done: 0, startedAt: 0, finishedAt: 0, error: undefined }
  }
}

/** Reuse one store across fiber reloads (it owns no unclosable resource). */
function sharedStore() {
  const holder = globalThis
  const existing = holder[STORE_KEY]
  if (existing instanceof ArtifactStore) return existing
  const created = new ArtifactStore()
  holder[STORE_KEY] = created
  return created
}

/**
 * Reconcile the per-Session cache with the current persistence listing.
 * Sessions whose revision is unchanged are reused untouched.
 */
async function scanAll(ctx, store, includeWritten, signal) {
  const snapshots = await ctx.sessionPersistence.list(signal === undefined ? undefined : { signal })
  const live = new Set()
  const stale = []
  const scan = store.scan
  scan.total = snapshots.length
  scan.done = 0
  scan.error = undefined

  for (const snapshot of snapshots) {
    if (!isRecord(snapshot) || !isRecord(snapshot.header)) continue
    const header = snapshot.header
    if (typeof header.id !== 'string') continue
    live.add(header.id)
    const cached = store.sessions.get(header.id)
    if (cached !== undefined && cached.revision === snapshot.revision) {
      scan.done += 1
      continue
    }
    stale.push({ header, revision: snapshot.revision })
  }

  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= stale.length) return
      if (signal?.aborted === true) return
      const target = stale[index]
      try {
        const folded = await foldSession(ctx.sessionPersistence, target.header, includeWritten, signal)
        store.sessions.set(target.header.id, { revision: target.revision, rows: folded.rows, meta: folded.meta })
      } catch (error) {
        // One unreadable Session must never fail the whole catalogue; keep the
        // previous entry so a transient read error does not erase history.
        scan.error = `${target.header.id}: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        scan.done += 1
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(1, stale.length)) }, worker),
  )

  // Drop Sessions that no longer exist at all.
  for (const id of [...store.sessions.keys()]) {
    if (!live.has(id)) store.sessions.delete(id)
  }
}

/** Start a reconciliation unless one is already running; never awaits it. */
function kickScan(ctx, store, includeWritten) {
  if (store.scanPromise !== null) return store.scanPromise
  store.scan.running = true
  store.scan.startedAt = Date.now()
  const controller = new AbortController()
  store.scanPromise = (async () => {
    try {
      await scanAll(ctx, store, includeWritten, controller.signal)
    } catch (error) {
      store.scan.error = error instanceof Error ? error.message : String(error)
    } finally {
      store.scan.running = false
      store.scan.finishedAt = Date.now()
      store.scanPromise = null
    }
  })()
  return store.scanPromise
}

/**
 * Start a reconciliation, at most once per `scanTtlMs`.
 *
 * The panel polls while the first scan runs and again on window focus, so the
 * cheap check (list revisions) would otherwise re-run on every poll. A request
 * that arrives inside the window reuses the catalogue it already has.
 */
function kickScanThrottled(ctx, store, includeWritten, scanTtlMs) {
  const last = store.scan.finishedAt
  if (store.scanPromise === null && last !== 0 && Date.now() - last < scanTtlMs) {
    return store.scanPromise
  }
  return kickScan(ctx, store, includeWritten)
}

/** Stat one path, reporting `{exists:false}` for any resolution failure. */
async function statOnce(path) {
  try {
    const info = await fsp.stat(path)
    if (!info.isFile()) return { exists: false }
    return { exists: true, mtimeMs: info.mtimeMs }
  } catch {
    return { exists: false }
  }
}

/** Refresh the TTL stat cache for every path the rows need. */
async function warmStatuses(store, rows, ttlMs, signal) {
  const now = Date.now()
  const pending = new Set()
  for (const row of rows) {
    const cached = store.status.get(row.path)
    if (cached !== undefined && now - cached.checkedAt < ttlMs) continue
    pending.add(row.path)
  }

  const targets = [...pending]
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= targets.length) return
      if (signal?.aborted === true) return
      const path = targets[index]
      const result = await statOnce(path)
      store.status.set(path, { checkedAt: Date.now(), ...result })
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, Math.max(1, targets.length)) }, worker),
  )
}

/**
 * Grade one row against its refreshed stat, or `undefined` to drop it.
 *
 * Command rows pass the production gate first: the file must exist and its
 * mtime must be at or after a call naming it; the LATEST such call is the
 * credited delivery time (a read-only mention keeps an older mtime and never
 * gates through, and a vanished file has no evidence left at all). Because
 * the evidence IS the current mtime, command rows are stable by construction.
 * Declared and structured rows are proven productions regardless of the file's
 * current state: they survive as `missing` (struck through) when the file is
 * gone, and grade `changed` when its mtime moved past the delivery time.
 */
function gradeRow(row, stat) {
  if (row.source === 'command') {
    if (stat === undefined || stat.exists !== true) return undefined
    const mtime = typeof stat.mtimeMs === 'number' ? stat.mtimeMs : Number.NEGATIVE_INFINITY
    let credited
    for (const occurrence of row.occurrences ?? [{ time: row.time }]) {
      if (occurrence.time <= mtime + MTIME_TOLERANCE_MS) credited = occurrence
    }
    if (credited === undefined) return undefined
    return {
      status: mtime > credited.time + MTIME_TOLERANCE_MS ? 'changed' : 'stable',
      time: credited.time,
    }
  }
  if (stat === undefined || stat.exists !== true) {
    return { status: 'missing', time: row.time }
  }
  const mtime = typeof stat.mtimeMs === 'number' ? stat.mtimeMs : Number.NEGATIVE_INFINITY
  return {
    status: mtime > row.time + MTIME_TOLERANCE_MS ? 'changed' : 'stable',
    time: row.time,
  }
}

/** Answer shape for both routes: `{ok:true, value}` or `{ok:false, error}`. */
function jsonOk(value) {
  return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}
function jsonError(code, message, status) {
  return Response.json({ ok: false, error: { code, message } },
    { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Look one row up by its (sessionId, rid) coordinates.
 *
 * The row is rebuilt from the cached fold — never from client-supplied data —
 * so an open request can only ever name a path this Host already derived from
 * a Session log. The native opener still re-verifies the path against the
 * composed filesystem.
 */
function findRow(store, sessionId, rid) {
  const entry = store.sessions.get(sessionId)
  if (entry === undefined) return undefined
  const row = entry.rows.find((candidate) => candidate.rid === rid)
  if (row === undefined) return undefined
  return { row, meta: entry.meta }
}

/** Serve the whole catalogue as JSON. */
function buildListHandler(ctx, store, settings) {
  const includeWritten = settings.includeWritten !== false
  const ttlMs = Number.isFinite(settings.statusTtlMs)
    ? Math.max(0, Number(settings.statusTtlMs))
    : 15000
  const scanTtlMs = Number.isFinite(settings.scanTtlMs)
    ? Math.max(0, Number(settings.scanTtlMs))
    : 60000

  return async (request) => {
    try {
      // Answer from whatever is folded, and make sure a scan is under way.
      void kickScanThrottled(ctx, store, includeWritten, scanTtlMs)

      const rows = []
      for (const entry of store.sessions.values()) {
        for (const row of entry.rows) rows.push(row)
      }

      await warmStatuses(store, rows, ttlMs, request.signal)

      const items = []
      for (const row of rows) {
        if (!includeWritten && row.source !== 'presented') continue
        const graded = gradeRow(row, store.status.get(row.path))
        if (graded === undefined) continue
        const meta = store.sessions.get(row.sessionId)?.meta ?? {}
        items.push({
          sessionId: row.sessionId,
          rid: row.rid,
          path: row.path,
          name: row.name,
          ext: row.ext,
          dir: dirname(row.path),
          ...(row.description === undefined ? {} : { description: row.description }),
          ...(row.turn === undefined ? {} : { turn: row.turn }),
          source: row.source,
          ...(row.instrument === undefined ? {} : { instrument: row.instrument }),
          time: graded.time,
          seq: row.seq,
          status: graded.status,
          ...(meta.title === undefined ? {} : { sessionTitle: meta.title }),
          ...(meta.subagent === true ? { sessionSubagent: true } : {}),
        })
      }
      // Newest first: the panel reads top-to-bottom in time order.
      items.sort((a, b) => (b.time - a.time) || (b.seq - a.seq))

      const counts = { stable: 0, changed: 0, missing: 0 }
      for (const item of items) counts[item.status] += 1

      const desktop = ctx.sessionController.workspaceDesktop()
      return jsonOk({
        items,
        counts,
        desktop: { available: desktop.available === true, fileManager: desktop.fileManager ?? null },
        scan: {
          running: store.scan.running,
          total: store.scan.total,
          done: store.scan.done,
          finishedAt: store.scan.finishedAt,
          ...(store.scan.error === undefined ? {} : { error: store.scan.error }),
        },
      })
    } catch (error) {
      return jsonError('scan-failed', error instanceof Error ? error.message : String(error), 500)
    }
  }
}

/**
 * Serve one native file action for a catalogued row.
 *
 * `open` starts the associated application; `reveal` shows the file in the
 * platform file manager. The path is looked up from the catalogue by its
 * (sessionId, rid) coordinates, canonicalized through the composed filesystem
 * exactly like the built-in deliverables cards (so a symlinked workspace,
 * such as a OneDrive vault, opens through its realpath), and only then handed
 * to the desktop opener.
 */
function buildOpenHandler(ctx, store) {
  return async (request) => {
    let coordinates
    try {
      const body = await request.json()
      if (!isRecord(body)) throw new Error('body must be an object')
      coordinates = body
    } catch {
      return jsonError('bad-request', 'expected a JSON body {sessionId, rid, action}', 400)
    }
    const sessionId = typeof coordinates.sessionId === 'string' ? coordinates.sessionId : undefined
    const rid = typeof coordinates.rid === 'string' && coordinates.rid.length > 0
      ? coordinates.rid
      : undefined
    const action = coordinates.action === 'reveal' ? 'reveal' : 'open'
    if (sessionId === undefined || rid === undefined) {
      return jsonError('bad-request', 'expected {sessionId, rid, action?}', 400)
    }

    const found = findRow(store, sessionId, rid)
    if (found === undefined) {
      return jsonError('not-found', 'no artifact at these coordinates', 404)
    }

    const desktop = ctx.sessionController.workspaceDesktop()
    if (desktop.available !== true) {
      return jsonError('desktop-unavailable', 'the serving Host has no desktop opener', 409)
    }

    try {
      const { fs } = ctx
      const target = await fs.resolve(found.row.path, { signal: request.signal })
      const canonical = fs.processPath(target)
      request.signal.throwIfAborted()
      await ctx.sessionController.openWorkspacePath({
        path: canonical,
        ...(action === 'reveal' ? { action } : {}),
      }, request.signal)
      return jsonOk({ opened: true, action })
    } catch (error) {
      if (request.signal?.aborted === true) return jsonError('cancelled', 'the open was cancelled', 499)
      const message = error instanceof Error ? error.message : String(error)
      const missing = /ENOENT|no such file|not found|no verified/i.test(message)
      return jsonError(missing ? 'file-unavailable' : 'open-failed', message, missing ? 404 : 500)
    }
  }
}

/**
 * Mount the artifact catalogue and open routes.
 * @param ctx - Host context carrying the authenticated connection and Session services.
 * @param config - the bundle row's config.
 */
export function apply(ctx, config = {}) {
  const settings = isRecord(config) ? config : {}
  const store = sharedStore()

  ctx.effect(() => {
    const disposeList = ctx.connection.fetch.register({
      path: '/api/artifact-timeline.list',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: buildListHandler(ctx, store, settings),
    })
    const disposeOpen = ctx.connection.fetch.register({
      path: '/api/artifact-timeline.open',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: buildOpenHandler(ctx, store),
    })
    return () => {
      void disposeList()
      void disposeOpen()
    }
  }, 'dsh-work-out: routes')

  // Warm the catalogue at activation so the first panel open is already useful.
  ctx.effect(() => {
    void kickScan(ctx, store, settings.includeWritten !== false)
    return () => {}
  }, 'dsh-work-out: warm scan')
}