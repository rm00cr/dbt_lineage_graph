/**
 * Top-bar "pipelines" stat chip that doubles as the pipeline filter: click it to pick
 * which pipelines are loaded. No pipeline ticked means all of them (the API default).
 */

import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { mockGraph } from '../api/mock'
import { useExplorerStore } from '../store/useExplorerStore'

export function PipelinePicker() {
  const meta = useExplorerStore((s) => s.meta)
  const usingMock = useExplorerStore((s) => s.usingMock)
  const visibleCount = useExplorerStore((s) => s.graph?.stats.pipelines.length ?? 0)
  const selected = useExplorerStore((s) => s.filters.pipelines)
  const setFilters = useExplorerStore((s) => s.setFilters)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // the graph only carries the pipelines in view, so take the full list from /meta
  const all = meta?.pipelines ?? (usingMock ? mockGraph.stats.pipelines : [])
  const filtered = selected.length > 0

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const apply = (next: string[]) => {
    // ticking every pipeline is the same as no filter; keep the URL clean
    void setFilters({ pipelines: next.length === all.length ? [] : next })
  }

  const isOn = (pipeline: string) => !filtered || selected.includes(pipeline)

  const toggle = (pipeline: string) => {
    const current = filtered ? selected : all
    const next = current.includes(pipeline) ? current.filter((p) => p !== pipeline) : [...current, pipeline]
    if (next.length === 0) return // never filter down to nothing
    apply(all.filter((p) => next.includes(p)))
  }

  return (
    <div className="pipeline-picker" ref={rootRef}>
      <button
        type="button"
        className={`stat-chip stat-chip--button ${filtered ? 'stat-chip--filtered' : ''} ${open ? 'stat-chip--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Choose which pipelines are shown"
      >
        <span className="stat-chip__value">
          {filtered && all.length > 0 ? `${visibleCount}/${all.length}` : visibleCount}
        </span>
        <span className="stat-chip__label">
          pipelines <ChevronDown size={10} className="stat-chip__caret" />
        </span>
      </button>

      {open && (
        <div className="pipeline-picker__menu" role="menu">
          <div className="pipeline-picker__head">
            <span>Show pipelines</span>
            <button type="button" className="pipeline-picker__link" onClick={() => apply([])} disabled={!filtered}>
              All
            </button>
          </div>
          {all.length === 0 && <div className="pipeline-picker__empty">No pipelines</div>}
          {all.map((pipeline) => (
            <div key={pipeline} className="pipeline-picker__row">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isOn(pipeline)}
                className="pipeline-picker__item"
                onClick={() => toggle(pipeline)}
              >
                <span className={`pipeline-picker__box ${isOn(pipeline) ? 'pipeline-picker__box--on' : ''}`}>
                  {isOn(pipeline) && <Check size={11} strokeWidth={3} />}
                </span>
                {pipeline}
              </button>
              <button
                type="button"
                className="pipeline-picker__link pipeline-picker__only"
                onClick={() => apply([pipeline])}
                title={`Show only ${pipeline}`}
              >
                only
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
