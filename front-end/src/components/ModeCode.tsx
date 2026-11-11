/**
 * Code tab of a model in a stacked pipeline (several execution modes shown at once).
 *
 *   mode switch   which mode's SQL is shown - and the base of the comparison
 *   Side by side  "<base> next to <other ▾>" (the side panel widens)
 *   Diff          "Diff <base> with <other ▾>": line diff of the compiled SQL, base -> other
 *
 * Models of single-mode pipelines just get the normal CodeViewer.
 */

import { Check, ChevronDown, Columns2, GitCompareArrows, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { ModelDetail } from '../api/types'
import { lineDiff } from '../graph/diff'
import { useExplorerStore } from '../store/useExplorerStore'
import { CodeViewer, WrapToggle } from './CodeViewer'
import { DiffLines } from './Compare'

type View = 'single' | 'side' | 'diff'

interface Loaded {
  detail?: ModelDetail
  error?: string
}

/** compiled SQL is what the vars of a mode change; raw SQL as a fallback */
const sqlOf = (detail: ModelDetail) => detail.compiled_code ?? detail.raw_code ?? ''

export function ModeCode({ detail, onWideChange }: { detail: ModelDetail; onWideChange: (wide: boolean) => void }) {
  const modes = useExplorerStore((s) => s.index.byId.get(detail.id)?.modes ?? null)
  const differs = useExplorerStore((s) => s.index.byId.get(detail.id)?.sql_differs ?? [])
  const [view, setView] = useState<View>('single')
  const [base, setBase] = useState<string>(modes?.[0] ?? '')
  const [other, setOther] = useState<string | null>(modes?.[1] ?? null)
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(new Map())

  // a new model or another stack: start over on its first (front) mode
  const modesKey = modes?.join('|') ?? ''
  useEffect(() => {
    setView('single')
    setBase(modes?.[0] ?? '')
    setOther(modes?.[1] ?? null)
    setLoaded(new Map())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, modesKey])

  // the base and the other mode are never the same
  const others = modes?.filter((m) => m !== base) ?? []
  const partner = other && other !== base ? other : (others[0] ?? null)

  const wide = view === 'side'
  useEffect(() => {
    onWideChange(wide)
    return () => onWideChange(false)
  }, [wide, onWideChange])

  // the detail we have is the first mode's; fetch the others when they are looked at
  const needed = useMemo(() => {
    if (!modes || modes.length < 2) return []
    const shown = view === 'single' ? [base] : [base, partner]
    return shown.filter((m): m is string => Boolean(m) && m !== modes[0])
  }, [modes, view, base, partner])

  useEffect(() => {
    for (const mode of needed) {
      if (loaded.has(mode)) continue
      setLoaded((prev) => new Map(prev).set(mode, {}))
      api
        .model(detail.id, undefined, mode)
        .then((result) => setLoaded((prev) => new Map(prev).set(mode, { detail: result })))
        .catch((error) =>
          setLoaded((prev) =>
            new Map(prev).set(mode, { error: error instanceof ApiError ? error.message : String(error) }),
          ),
        )
    }
  }, [needed, loaded, detail.id])

  if (!modes || modes.length < 2) {
    return <CodeViewer compiled={detail.compiled_code} raw={detail.raw_code} fileName={detail.name} />
  }

  const versionOf = (mode: string): Loaded => (mode === modes[0] ? { detail } : (loaded.get(mode) ?? {}))
  const label = (mode: string) => (mode === modes[0] ? `${mode} (front)` : mode)

  const viewer = (mode: string) => {
    const version = versionOf(mode)
    if (version.error) return <div className="empty">Could not load {mode}: {version.error}</div>
    if (!version.detail)
      return (
        <div className="empty">
          <Loader2 size={13} className="spin" /> Loading {mode}…
        </div>
      )
    return (
      <CodeViewer
        key={mode}
        compiled={version.detail.compiled_code}
        raw={version.detail.raw_code}
        fileName={`${detail.name}.${mode}`}
      />
    )
  }

  return (
    <div className="mode-code">
      <div className="mode-code__bar">
        <div className="segmented" role="group" aria-label="Execution mode of the code">
          {modes.map((mode) => (
            <button
              key={mode}
              data-active={base === mode}
              onClick={() => setBase(mode)}
              title={`${label(mode)}${differs.includes(mode) ? ': other SQL than the front mode' : ''}`}
            >
              {mode}
              {differs.includes(mode) && <span className="stack__differs">≠</span>}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Compare modes">
          <button
            data-active={view === 'side'}
            onClick={() => setView(view === 'side' ? 'single' : 'side')}
            title="Show two modes next to each other"
          >
            <Columns2 size={12} /> Side by side
          </button>
          <button
            data-active={view === 'diff'}
            onClick={() => setView(view === 'diff' ? 'single' : 'diff')}
            title="Line diff of the compiled SQL"
          >
            <GitCompareArrows size={12} /> Diff
          </button>
        </div>
      </div>

      {view !== 'single' && partner && (
        <div className="mode-code__sentence">
          <span>{view === 'diff' ? 'Diff' : 'Show'}</span>
          <strong className="mode-code__base">{base}</strong>
          <span>{view === 'diff' ? 'with' : 'next to'}</span>
          <ModeMenu value={partner} options={others} label={label} onChange={setOther} />
          {view === 'diff' && <span className="mode-code__hint">compiled SQL</span>}
        </div>
      )}

      {view === 'single' && viewer(base)}

      {view === 'side' && partner && (
        <div className="mode-code__side">
          <div>
            <div className="mode-code__head" data-base="true">
              {label(base)}
            </div>
            {viewer(base)}
          </div>
          <div>
            <div className="mode-code__head">{label(partner)}</div>
            {viewer(partner)}
          </div>
        </div>
      )}

      {view === 'diff' && partner && (
        <ModeDiff from={base} to={partner} a={versionOf(base)} b={versionOf(partner)} />
      )}
    </div>
  )
}

/** A small popover picker (instead of a native select), styled like the other menus. */
function ModeMenu({
  value,
  options,
  label,
  onChange,
}: {
  value: string
  options: string[]
  label: (mode: string) => string
  onChange: (mode: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  const single = options.length < 2
  return (
    <span className="mode-menu" ref={ref}>
      <button
        type="button"
        className="mode-menu__button"
        data-open={open}
        disabled={single}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Compare with ${value}`}
        onClick={() => setOpen((v) => !v)}
      >
        {label(value)}
        {!single && <ChevronDown size={12} className="mode-menu__caret" />}
      </button>
      {open && (
        <span className="mode-menu__list" role="listbox" aria-label="Compare with">
          {options.map((mode) => (
            <button
              key={mode}
              type="button"
              role="option"
              aria-selected={mode === value}
              className="mode-menu__item"
              onClick={() => {
                onChange(mode)
                setOpen(false)
              }}
            >
              <span className="mode-menu__check">{mode === value && <Check size={12} strokeWidth={3} />}</span>
              {label(mode)}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

function ModeDiff({ from, to, a, b }: { from: string; to: string; a: Loaded; b: Loaded }) {
  const lines = useMemo(
    () => (a.detail && b.detail ? lineDiff(sqlOf(a.detail), sqlOf(b.detail)) : null),
    [a.detail, b.detail],
  )
  if (a.error || b.error) return <div className="empty">Could not load: {a.error ?? b.error}</div>
  if (!lines)
    return (
      <div className="empty">
        <Loader2 size={13} className="spin" /> Loading…
      </div>
    )
  const changed = lines.some((line) => line.kind === 'add' || line.kind === 'del')
  return (
    <>
      <div className="mode-code__legend">
        <span className="diff-word diff-word--removed">− only in {from}</span>
        <span className="diff-word diff-word--added">+ only in {to}</span>
        <span style={{ flex: 1 }} />
        <WrapToggle />
      </div>
      {changed ? (
        <DiffLines lines={lines} label={`SQL diff ${from} with ${to}`} />
      ) : (
        <div className="empty">Same SQL in {from} and {to}.</div>
      )}
    </>
  )
}
