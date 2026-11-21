/**
 * Artifact timeline — Client half.
 *
 * Registers one global panel:
 *
 *  - `sidebar.panellist` — the left-sidebar icon row, id `artifact-timeline`;
 *  - `main`               — the panel that row selects, same id.
 *
 * The panel lists every file recorded across all conversations, newest first,
 * and marks the ones that changed or disappeared after they were produced.
 * Hovering or keyboard-focusing a row reveals its actions: open the file on
 * the Host desktop, reveal it in the file manager, copy its path, or jump to
 * the conversation that produced it.
 *
 * Visible text goes through the Client locale service; every colour is a
 * `--dsw-alias-*` theme token so light and dark both read correctly. All
 * controls are written here — no Harness Client package is imported as a
 * module (uiWorkspace is reached through the Cordis service context).
 */

window.__ModuleLoader__.load({
  id: 'dsh-work-out',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const LOCALE_NS = 'artifactTimeline'
    const PANEL_ID = 'artifact-timeline'
    const PANEL_ORDER = 20
    const LIST_ROUTE = 'api/artifact-timeline.list'
    const OPEN_ROUTE = 'api/artifact-timeline.open'

    const en = {
      nav: 'Artifact timeline',
      title: 'Artifact timeline',
      loading: 'Reading conversation artifacts…',
      scanning: 'Scanning conversations',
      empty: 'No artifact recorded yet.',
      emptyHint: 'Files appear here once a conversation writes or presents one.',
      emptyFiltered: 'No file matches this filter.',
      retry: 'Retry',
      refresh: 'Refresh',
      error: 'Could not read the artifact catalogue.',
      filterAll: 'All',
      filterKept: 'Kept',
      filterChanged: 'Changed',
      filterMissing: 'Deleted',
      search: 'Filter by name, path, or conversation',
      statusStable: 'Kept',
      statusChanged: 'Changed',
      statusMissing: 'Deleted',
      sourcePresented: 'Delivered',
      sourceWritten: 'Written',
      sourceCommand: 'Script',
      countOne: '1 file',
      countMany: '{count} files',
      legend: 'Green kept · amber changed after production · red deleted from disk.',
      today: 'Today',
      yesterday: 'Yesterday',
      actionOpen: 'Open',
      actionReveal: 'Reveal in folder',
      actionCopy: 'Copy path',
      actionSession: 'Open the conversation',
      copied: 'Path copied',
      copyFailed: 'Clipboard unavailable in this browser context.',
      opened: 'Opened',
      revealed: 'Revealed',
      openFailed: 'Could not open the file.',
      revealFailed: 'Could not reveal the file.',
      goneTitle: 'This file no longer exists on disk.',
      desktopTitle: 'This Host has no desktop file opener.',
      noSession: 'The conversation is no longer available.',
      sessionLabel: 'From',
      subagentNote: 'subagent',
      justNow: 'just now',
      minutesAgo: '{count} min ago',
      hoursAgo: '{count} h ago',
      daysAgo: '{count} d ago',
    }

    const zh = {
      nav: '产物时间线',
      title: '产物时间线',
      loading: '正在读取对话产物…',
      scanning: '正在扫描对话',
      empty: '暂无产物记录。',
      emptyHint: '当对话写出或交付文件后，这里会自动出现。',
      emptyFiltered: '没有符合筛选的文件。',
      retry: '重试',
      refresh: '刷新',
      error: '无法读取产物目录。',
      filterAll: '全部',
      filterKept: '正常',
      filterChanged: '已更改',
      filterMissing: '已删除',
      search: '按文件名、路径或对话标题筛选',
      statusStable: '正常',
      statusChanged: '已更改',
      statusMissing: '已删除',
      sourcePresented: '已交付',
      sourceWritten: '已写入',
      sourceCommand: '脚本生成',
      countOne: '1 个文件',
      countMany: '{count} 个文件',
      legend: '绿色＝正常 · 黄色＝产出后被更改 · 红色＝磁盘上已删除。',
      today: '今天',
      yesterday: '昨天',
      actionOpen: '打开',
      actionReveal: '打开所在文件夹',
      actionCopy: '复制路径',
      actionSession: '跳到该对话',
      copied: '已复制路径',
      copyFailed: '当前浏览器环境不允许访问剪贴板。',
      opened: '已打开',
      revealed: '已定位',
      openFailed: '无法打开该文件。',
      revealFailed: '无法定位该文件。',
      goneTitle: '该文件在磁盘上已不存在。',
      desktopTitle: '本机没有可用的桌面打开方式。',
      noSession: '该对话已不可用。',
      sessionLabel: '来自',
      subagentNote: '子代理',
      justNow: '刚刚',
      minutesAgo: '{count} 分钟前',
      hoursAgo: '{count} 小时前',
      daysAgo: '{count} 天前',
    }

    const fill = (template, count) => template.split('{count}').join(String(count))

    /**
     * `dsh-resource://file/session/<id>/<path>` — the one address the in-app
     * document preview claims. Segments are component-encoded the way the
     * Host's own `sessionFileAddress` builds them (a drive-letter `:` stays
     * literal), and an absolute path rides inside the session scope because
     * the document preview opens no other scope.
     */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'
    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
    function encodePath(path) {
      return path.split('/').map(encodeSegment).join('/')
    }
    function fileAddressFor(sessionId, path) {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return `${FILE_ADDRESS_PREFIX}${encodeSegment(sessionId)}/${encodePath(normalized)}`
    }

    /** Extensions the document preview cannot render (binary containers, media). */
    const NON_PREVIEWABLE = new Set([
      'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
      'mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'ogg', 'm4a',
      'epub', 'odt', 'ods', 'odp', 'pages', 'key', 'numbers', 'rtf',
      'exe', 'dll', 'bin', 'so', 'dylib', 'iso', 'dmg',
    ])

    /** Whether the in-app preview can show this file, honestly. */
    function isPreviewable(ext) {
      if (typeof ext !== 'string' || ext === '') return false
      return !NON_PREVIEWABLE.has(ext.toLowerCase())
    }

    /** Relative age of one event, read beside the row it belongs to. */
    function relativeTime(time, t) {
      const delta = Date.now() - time
      const minute = 60000
      const hour = 60 * minute
      const day = 24 * hour
      if (delta < minute) return t('justNow')
      if (delta < hour) return fill(t('minutesAgo'), Math.floor(delta / minute))
      if (delta < day) return fill(t('hoursAgo'), Math.floor(delta / hour))
      if (delta < 7 * day) return fill(t('daysAgo'), Math.floor(delta / day))
      const date = new Date(time)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    /** Day heading: Today / Yesterday / a recent count / a stable date. */
    function dayLabel(time, t) {
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const that = new Date(time)
      that.setHours(0, 0, 0, 0)
      const days = Math.round((dayStart.getTime() - that.getTime()) / 86400000)
      if (days <= 0) return t('today')
      if (days === 1) return t('yesterday')
      if (days < 7) return fill(t('daysAgo'), days)
      return `${that.getFullYear()}-${String(that.getMonth() + 1).padStart(2, '0')}-${String(that.getDate()).padStart(2, '0')}`
    }

    /**
     * The panel stylesheet. One id-guarded <style> in the document head,
     * written at factory time: every panel state (including the loading note)
     * is styled before React renders, an HMR regeneration refreshes the same
     * element instead of stacking a second one, and nothing leaks per mount.
     */
    const CSS = `
.at-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
.at-head {
  display: flex; flex-direction: column; gap: 10px;
  padding: 20px 24px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: 0 0 auto;
}
.at-title-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.at-title { font-size: 17px; font-weight: 600; margin: 0; }
.at-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 0; }
.at-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.at-search {
  flex: 1 1 200px; min-width: 140px; padding: 6px 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; outline: none;
}
.at-search:focus { border-color: var(--dsw-alias-brand-primary); }
.at-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px;
  white-space: nowrap;
}
.at-chip[aria-pressed="true"] {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.at-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.at-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.at-button {
  padding: 5px 10px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
}
.at-button:hover { background: var(--dsw-alias-bg-layer-2); }
.at-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.at-body { flex: 1 1 auto; overflow: auto; padding: 4px 12px 16px; min-height: 0; }
.at-group { margin-top: 12px; }
.at-group-head {
  position: sticky; top: 0; z-index: 1;
  padding: 6px 12px; margin: 0 0 2px;
  font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.at-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 7px;
  border-left: 3px solid transparent;
}
.at-row:hover { background: var(--dsw-alias-bg-layer-1); }
.at-row:focus-within { background: var(--dsw-alias-bg-layer-1); }
.at-row.is-missing { border-left-color: var(--dsw-alias-state-error-primary); }
.at-row.is-changed { border-left-color: var(--dsw-alias-state-warn-primary); }
.at-row.is-stable { border-left-color: var(--dsw-alias-state-success-primary); }
.at-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.at-row-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.at-row.is-missing .at-row-name {
  text-decoration: line-through; color: var(--dsw-alias-label-secondary);
}
.at-row-path {
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.at-row-meta { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.at-badge {
  font-size: 11px; padding: 2px 7px; border-radius: 999px; white-space: nowrap;
  border: 1px solid currentColor; line-height: 1.4;
}
.at-badge.is-stable { color: var(--dsw-alias-state-success-primary); }
.at-badge.is-changed { color: var(--dsw-alias-state-warn-primary); }
.at-badge.is-missing { color: var(--dsw-alias-state-error-primary); }
.at-badge.is-source { color: var(--dsw-alias-label-secondary); }
.at-ext {
  width: 34px; height: 34px; flex: 0 0 auto; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
}
.at-time { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.at-actions {
  display: flex; align-items: center; gap: 2px; flex: 0 0 auto;
  opacity: 0; transition: opacity .12s ease;
}
.at-row:hover .at-actions, .at-row:focus-within .at-actions { opacity: 1; }
.at-action {
  width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.at-action:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.at-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.at-action:disabled { opacity: .4; cursor: default; }
.at-note {
  padding: 28px 20px; text-align: center; color: var(--dsw-alias-label-secondary);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.at-foot {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 7px 24px 10px; border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px; color: var(--dsw-alias-label-secondary); min-height: 30px;
}
.at-foot.is-ok { color: var(--dsw-alias-state-success-primary); }
.at-foot.is-err { color: var(--dsw-alias-state-error-primary); }
.at-spinner {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: at-spin .8s linear infinite;
}
.at-spinner.is-small { width: 11px; height: 11px; border-width: 2px; }
@keyframes at-spin { to { transform: rotate(360deg); } }
`

    /**
     * Insert the panel stylesheet once per module generation. Prefers the
     * platform `styles` builtin (cleaned up with the Client run, so uninstall
     * removes it); the manual fallback is id-guarded, so an HMR regeneration
     * refreshes the same element instead of stacking a second one.
     */
    function ensureCss() {
      if (typeof styles !== 'undefined' && styles !== null && typeof styles.insert === 'function') {
        try { styles.insert(CSS); return } catch { /* fall through */ }
      }
      if (typeof document === 'undefined') return
      const id = 'dsh-work-out-css'
      let element = document.getElementById(id)
      if (element === null) {
        element = document.createElement('style')
        element.id = id
        document.head.appendChild(element)
      }
      element.textContent = CSS
    }
    ensureCss()

    /** Shared SVG defaults for the row-action glyphs. */
    function glyph(props) {
      return Object.assign({
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, props)
    }

    function OpenGlyph() {
      return h('svg', glyph(), [
        h('path', { key: 'a', d: 'M14 4h6v6' }),
        h('path', { key: 'b', d: 'M20 4 11 13' }),
        h('path', { key: 'c', d: 'M18 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5' }),
      ])
    }

    function RevealGlyph() {
      return h('svg', glyph(), [
        h('path', { key: 'a', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }),
      ])
    }

    function CopyGlyph() {
      return h('svg', glyph(), [
        h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }),
        h('path', { key: 'b', d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
      ])
    }

    function SessionGlyph() {
      return h('svg', glyph(), [
        h('path', { key: 'a', d: 'M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z' }),
      ])
    }

    /** The left-sidebar glyph: stacked sheets, reading as a catalogue. */
    function TimelineIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('path', { key: 'a', d: 'M6 3.5h8.5L19 8v12.5H6z' }),
        h('path', { key: 'b', d: 'M14 3.5V8h4.5' }),
        h('path', { key: 'c', d: 'M3.5 6.5v14h11' }),
        h('path', { key: 'd', d: 'M9 12h7M9 15.5h4.5', opacity: 0.65 }),
      ])
    }

    /**
     * One row action button. Self-drawn (no Harness primitive import): a real
     * `<button>` with an accessible name, a busy state that replaces the
     * glyph, and an honest disabled state whose tooltip says the reason.
     */
    function ActionButton(props) {
      const { label, title, disabled, busy, onPress, children } = props
      return h('button', {
        type: 'button',
        className: 'at-action',
        'aria-label': label,
        title: title === undefined ? label : title,
        disabled: disabled === true || busy === true,
        onClick: (event) => {
          event.stopPropagation()
          onPress()
        },
      }, busy === true
        ? h('span', { className: 'at-spinner is-small' })
        : children)
    }

    /** One timeline row: chip, name, path, source, status, age, actions. */
    function ArtifactRow(props) {
      const { item, t, desktopAvailable, busy, onAction } = props
      const statusLabel = item.status === 'missing'
        ? t('statusMissing')
        : item.status === 'changed' ? t('statusChanged') : t('statusStable')
      const gone = item.status === 'missing'
      const nativeDisabled = gone || desktopAvailable !== true
      const nativeTitle = gone
        ? t('goneTitle')
        : desktopAvailable !== true ? t('desktopTitle') : undefined
      const key = `${item.sessionId}:${item.rid}`

      const rowTitle = item.description === undefined ? item.path : `${item.path}\n${item.description}`
      const sessionLabel = item.sessionTitle === undefined
        ? t('actionSession')
        : `${t('actionSession')} · ${t('sessionLabel')} ${item.sessionTitle}${item.sessionSubagent === true ? ` (${t('subagentNote')})` : ''}`
      return h('div', { className: `at-row is-${item.status}`, title: rowTitle }, [
        h('div', { className: 'at-ext', key: 'ext' }, item.ext === '' ? 'file' : item.ext),
        h('div', { className: 'at-row-main', key: 'main' }, [
          h('div', { className: 'at-row-name', key: 'n' }, item.name),
          h('div', { className: 'at-row-path', key: 'p' },
            item.description === undefined ? item.dir : `${item.dir} — ${item.description}`),
        ]),
        h('div', { className: 'at-row-meta', key: 'meta' }, [
          h('span', { key: 'src', className: 'at-badge is-source' },
            item.source === 'presented' ? t('sourcePresented')
              : item.source === 'command' ? t('sourceCommand') : t('sourceWritten')),
          h('span', { key: 'st', className: `at-badge is-${item.status}` }, statusLabel),
          h('span', { key: 'tm', className: 'at-time' }, relativeTime(item.time, t)),
        ]),
        h('div', { className: 'at-actions', key: 'actions' }, [
          h(ActionButton, {
            key: 'open',
            label: t('actionOpen'),
            title: nativeTitle,
            disabled: nativeDisabled,
            busy: busy[`${key}:open`] === true,
            onPress: () => onAction(item, 'open'),
          }, h(OpenGlyph, {})),
          h(ActionButton, {
            key: 'reveal',
            label: t('actionReveal'),
            title: nativeTitle,
            disabled: nativeDisabled,
            busy: busy[`${key}:reveal`] === true,
            onPress: () => onAction(item, 'reveal'),
          }, h(RevealGlyph, {})),
          h(ActionButton, {
            key: 'copy',
            label: t('actionCopy'),
            busy: busy[`${key}:copy`] === true,
            onPress: () => onAction(item, 'copy'),
          }, h(CopyGlyph, {})),
          h(ActionButton, {
            key: 'session',
            label: sessionLabel,
            title: sessionLabel,
            onPress: () => onAction(item, 'session'),
          }, h(SessionGlyph, {})),
        ]),
      ])
    }

    /** The panel: toolbar, day-grouped timeline, actions, empty and error states. */
    function ArtifactTimelinePanel(props) {
      const t = props.t
      const revealArtifact = props.revealArtifact
      const [state, setState] = useState({ phase: 'loading', value: null, error: '' })
      const [filter, setFilter] = useState('all')
      const [query, setQuery] = useState('')
      const [foot, setFoot] = useState({ text: '', tone: '' })
      const [busy, setBusy] = useState({})
      // Re-render once a minute so relative ages stay honest while reading.
      const [, setAgeTick] = useState(0)
      const alive = useRef(true)
      const footTimer = useRef(undefined)

      const flash = useCallback((text, tone) => {
        setFoot({ text, tone })
        if (footTimer.current !== undefined) clearTimeout(footTimer.current)
        footTimer.current = setTimeout(() => { if (alive.current) setFoot({ text: '', tone: '' }) }, 2200)
      }, [])

      const load = useCallback(() => {
        fetch(LIST_ROUTE, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const body = await response.json()
            if (!alive.current) return
            if (body !== null && typeof body === 'object' && body.ok === true) {
              setState({ phase: 'ready', value: body.value, error: '' })
            } else {
              const detail = body && body.error ? String(body.error.message || body.error.code || '') : ''
              setState({ phase: 'error', value: null, error: detail })
            }
          })
          .catch((error) => {
            if (!alive.current) return
            setState({
              phase: 'error',
              value: null,
              error: error instanceof Error ? error.message : String(error),
            })
          })
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        const ageTimer = setInterval(() => { setAgeTick((tick) => tick + 1) }, 60000)
        return () => {
          alive.current = false
          clearInterval(ageTimer)
          if (footTimer.current !== undefined) clearTimeout(footTimer.current)
        }
      }, [load])

      const scanning = state.phase === 'ready' && state.value !== null
        && state.value.scan !== undefined && state.value.scan.running === true
      const done = scanning ? state.value.scan.done : 0
      const total = scanning ? state.value.scan.total : 0
      const desktopAvailable = state.phase === 'ready' && state.value !== null
        && state.value.desktop !== undefined && state.value.desktop.available === true

      // While a scan runs, poll so rows stream in.
      useEffect(() => {
        if (!scanning) return undefined
        const timer = setInterval(load, 1500)
        return () => clearInterval(timer)
      }, [scanning, load])

      // Re-read when the window regains focus: files may have changed on disk.
      useEffect(() => {
        const onFocus = () => load()
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [load])

      const items = state.phase === 'ready' && state.value !== null && Array.isArray(state.value.items)
        ? state.value.items
        : []
      const counts = state.phase === 'ready' && state.value !== null && state.value.counts !== undefined
        ? state.value.counts
        : { stable: 0, changed: 0, missing: 0 }

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return items.filter((item) => {
          if (filter === 'kept' && item.status !== 'stable') return false
          if (filter === 'changed' && item.status !== 'changed') return false
          if (filter === 'missing' && item.status !== 'missing') return false
          if (needle === '') return true
          return item.name.toLowerCase().indexOf(needle) !== -1
            || item.path.toLowerCase().indexOf(needle) !== -1
            || (typeof item.sessionTitle === 'string' && item.sessionTitle.toLowerCase().indexOf(needle) !== -1)
        })
      }, [items, filter, query])

      /** Group by calendar day, so the feed reads as dated sections. */
      const groups = useMemo(() => {
        const out = []
        let current = null
        for (const item of filtered) {
          const date = new Date(item.time)
          const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
          if (current === null || current.key !== key) {
            current = { key, time: item.time, items: [] }
            out.push(current)
          }
          current.items.push(item)
        }
        return out
      }, [filtered])

      /**
       * One action for one row. The busy key is the stable
       * (sessionId, rid) pair ArtifactRow reads — seq alone collides across
       * the several files one present event declares.
       */
      const onAction = useCallback((item, action) => {
        const key = `${item.sessionId}:${item.rid}`
        if (action === 'session') {
          // Synchronous by design: the conversation is selected, the line that
          // produced the artifact is brought into view, and the file opens in
          // the right Sidebar; a dead Session throws right here.
          try {
            revealArtifact(item)
          } catch (error) {
            flash(error instanceof Error && error.message !== '' ? error.message : t('noSession'), 'is-err')
          }
          return
        }
        if (action === 'copy') {
          const clipboard = navigator.clipboard
          if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
            flash(t('copyFailed'), 'is-err')
            return
          }
          clipboard.writeText(item.path).then(
            () => { if (alive.current) flash(t('copied'), 'is-ok') },
            () => { if (alive.current) flash(t('copyFailed'), 'is-err') },
          )
          return
        }
        // open / reveal: ask the Host, which re-canonicalizes the path itself.
        setBusy((current) => ({ ...current, [`${key}:${action}`]: true }))
        fetch(OPEN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: item.sessionId, rid: item.rid, action }),
        })
          .then(async (response) => {
            const body = await response.json()
            if (!alive.current) return
            if (body !== null && typeof body === 'object' && body.ok === true) {
              flash(action === 'open' ? t('opened') : t('revealed'), 'is-ok')
              // An open can make a previously-missing file present again only
              // if the catalogue drifted; the status TTL converges it anyway.
            } else {
              const message = body && body.error ? String(body.error.message || '') : ''
              flash(`${action === 'open' ? t('openFailed') : t('revealFailed')}${message === '' ? '' : ` — ${message}`}`, 'is-err')
            }
          })
          .catch((error) => {
            if (!alive.current) return
            const message = error instanceof Error ? error.message : ''
            flash(`${action === 'open' ? t('openFailed') : t('revealFailed')}${message === '' ? '' : ` — ${message}`}`, 'is-err')
          })
          .finally(() => {
            if (!alive.current) return
            setBusy((current) => {
              const next = { ...current }
              delete next[`${key}:${action}`]
              return next
            })
          })
      }, [revealArtifact, flash, t])

      const chips = [
        { id: 'all', label: t('filterAll'), count: items.length, color: null },
        { id: 'kept', label: t('filterKept'), count: counts.stable, color: 'var(--dsw-alias-state-success-primary)' },
        { id: 'changed', label: t('filterChanged'), count: counts.changed, color: 'var(--dsw-alias-state-warn-primary)' },
        { id: 'missing', label: t('filterMissing'), count: counts.missing, color: 'var(--dsw-alias-state-error-primary)' },
      ]

      const headline = scanning
        ? `${t('scanning')} ${done}/${total}`
        : fill(items.length === 1 ? t('countOne') : t('countMany'), items.length)

      let body
      if (state.phase === 'loading') {
        body = h('div', { className: 'at-note' }, [
          h('span', { key: 'sp', className: 'at-spinner' }),
          h('span', { key: 'm' }, t('loading')),
        ])
      } else if (state.phase === 'error') {
        body = h('div', { className: 'at-note' }, [
          h('span', { key: 'm' }, t('error')),
          h('span', { key: 'd', style: { fontSize: '11px' } }, state.error),
          h('button', { key: 'b', type: 'button', className: 'at-button', onClick: load }, t('retry')),
        ])
      } else if (groups.length === 0) {
        body = h('div', { className: 'at-note' }, [
          h('span', { key: 'm' }, items.length > 0 ? t('emptyFiltered') : t('empty')),
          h('span', { key: 'h', style: { fontSize: '11px' } }, items.length > 0 ? '' : t('emptyHint')),
        ])
      } else {
        body = groups.map((group) => h('section', { className: 'at-group', key: group.key }, [
          h('div', { className: 'at-group-head', key: 'g' }, dayLabel(group.time, t)),
          ...group.items.map((item) => h(ArtifactRow, {
            key: `${item.sessionId}:${item.rid}`,
            item,
            t,
            desktopAvailable,
            busy,
            onAction,
          })),
        ]))
      }

      return h('div', { className: 'at-root' }, [
        h('header', { className: 'at-head', key: 'head' }, [
          h('div', { className: 'at-title-row', key: 'tr' }, [
            h('h1', { className: 'at-title', key: 't' }, t('title')),
            h('p', { className: 'at-sub', key: 's' }, headline),
          ]),
          h('div', { className: 'at-toolbar', key: 'tb' }, [
            h('input', {
              key: 'q',
              className: 'at-search',
              type: 'search',
              value: query,
              placeholder: t('search'),
              'aria-label': t('search'),
              onChange: (event) => setQuery(event.target.value),
            }),
            ...chips.map((chip) => h('button', {
              key: chip.id,
              type: 'button',
              className: 'at-chip',
              'aria-pressed': filter === chip.id,
              onClick: () => setFilter(chip.id),
            }, [
              chip.color === null ? null : h('span', {
                key: 'dot',
                className: 'at-chip-dot',
                style: { color: chip.color },
              }),
              h('span', { key: 'l' }, `${chip.label} ${chip.count}`),
            ])),
            h('button', {
              key: 'r',
              type: 'button',
              className: 'at-button',
              onClick: load,
              disabled: scanning,
            }, t('refresh')),
          ]),
        ]),
        h('div', { className: 'at-body', key: 'body' }, body),
        h('div', { className: `at-foot ${foot.tone}`, key: 'foot', 'aria-live': 'polite' },
          foot.text === '' ? t('legend') : foot.text),
      ])
    }

    return {
      // `sidebarRight` is a reflect-provided service: declaring it here is
      // what binds ctx.sidebarRight (ctx.get cannot resolve reflect services).
      inject: ['slots', 'locale', 'sidebarRight'],
      /** Test seam: the address builder and the preview gate, pure and closed. */
      _internals: { fileAddressFor, isPreviewable },
      apply(ctx) {
        ctx.effect(() => {
          const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
          const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
          return () => { offZh(); offEn() }
        }, 'artifact-timeline: dictionaries')

        const t = ctx.locale.bind(LOCALE_NS)

        /**
         * Jump to the conversation that produced one artifact.
         *
         * `uiWorkspace.openSession` selects the Session and reveals the
         * conversation panel. The row's own Session id rides the catalogue, so
         * the Host still owns existence; a dead Session surfaces through the
         * thrown error the panel flashes. Subagent logs open as their own
         * Session, which is exactly what the row recorded.
         */
        /** Select a conversation; throws when the Workspace seat is absent. */
        const selectSession = (item) => {
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') {
            throw new Error(t('noSession'))
          }
          if (typeof item.sessionId !== 'string' || item.sessionId === '') {
            throw new Error(t('noSession'))
          }
          uiWorkspace.openSession(item.sessionId)
        }

        /**
         * Bring the conversation row that mentions this artifact into view.
         *
         * The Conversation exposes no "scroll to this event" call — its
         * viewport class is package-internal — so this reads the same anchors
         * the viewport itself scrolls by: rows carrying `data-chat-turn` inside
         * `[data-conversation-scroll]`. It matches on the file name, and older
         * content that is not loaded yet simply does not match: the jump still
         * lands, and the view is never scrolled to a guess.
         */
        const scrollToOccurrence = (item) => {
          if (typeof document === 'undefined') return
          if (typeof item.name !== 'string' || item.name === '') return
          let rows
          try {
            rows = document.querySelectorAll('[data-conversation-scroll] [data-chat-turn]')
          } catch {
            return
          }
          for (const row of rows) {
            const text = row.textContent
            if (text !== null && text.indexOf(item.name) !== -1) {
              try {
                row.scrollIntoView({ block: 'center' })
              } catch {
                // A layout-only nicety; a failed scroll changes no content.
              }
              return
            }
          }
        }

        /**
         * One gesture on the conversation action: show that conversation, put
         * the line that produced the artifact in view, and open the file in the
         * right Sidebar's document preview at its `dsh-resource://file/…`
         * address. The preview is best-effort — a type the document preview
         * cannot render, a missing Sidebar, or a gone file leaves the jump
         * intact instead of failing the whole gesture.
         */
        const revealArtifact = (item) => {
          const sidebarRight = ctx.sidebarRight
          const mountedSession = () => {
            try {
              return typeof sidebarRight?.mounted?.getSnapshot === 'function'
                ? sidebarRight.mounted.getSnapshot()
                : undefined
            } catch {
              return undefined
            }
          }
          // A preview is read-only and the address names its own Session, so it
          // opens beside whatever conversation is on screen.
          const openPreview = () => {
            if (item.status === 'missing' || !isPreviewable(item.ext)) return
            if (sidebarRight === undefined || sidebarRight === null
              || typeof sidebarRight.openResource !== 'function') return
            try {
              sidebarRight.openResource(
                fileAddressFor(item.sessionId, item.path),
                { destination: 'sidebar' },
              )
            } catch {
              // A rejected address or an unmounted pane changes nothing here.
            }
          }
          const settle = () => {
            scrollToOccurrence(item)
            openPreview()
          }
          if (mountedSession() === item.sessionId) {
            // Already here: only the view and the pane change, no navigation.
            settle()
            return
          }
          selectSession(item)
          // The tab domain and the view both need the arriving Session mounted,
          // which settles a render after the selection. Bounded, so a Session
          // that never mounts still scrolls instead of hanging on.
          let elapsed = 0
          const timer = setInterval(() => {
            elapsed += 100
            if (mountedSession() === item.sessionId) {
              clearInterval(timer)
              setTimeout(settle, 120)
              return
            }
            if (elapsed >= 3000) {
              clearInterval(timer)
              setTimeout(() => scrollToOccurrence(item), 200)
            }
          }, 100)
        }

        // The panel itself, addressed by the sidebar row below.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: LOCALE_NS,
          inject: () => ({ revealArtifact }),
        }, ArtifactTimelinePanel))

        // The left-sidebar row. The sidebar owns the button, its label, and the
        // selected state; this supplies only the glyph.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => t('nav'),
          locale: LOCALE_NS,
        }, TimelineIcon))
      },
    }
  },
})