/**
 * Help menu in the top bar: the guided tours (src/tour/tours.tsx), ticked off once finished.
 * `?` opens it from anywhere. A dot on the button invites first-time users until they finish
 * any tour; nothing starts on its own.
 */

import { CheckCircle2, ChevronRight, CircleHelp, RotateCcw } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { TOURS } from '../tour/tours'
import { useTourStore } from '../tour/useTourStore'

export function HelpMenu() {
  const open = useTourStore((s) => s.menuOpen)
  const setOpen = useTourStore((s) => s.setMenuOpen)
  const completed = useTourStore((s) => s.completed)
  const start = useTourStore((s) => s.start)
  const resetProgress = useTourStore((s) => s.resetProgress)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, setOpen])

  const done = TOURS.filter((t) => completed.has(t.id)).length

  return (
    <div className="help" ref={ref}>
      <button
        type="button"
        data-tour="help"
        className={`btn btn--sm${open ? ' btn--active' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Guided tours (?)"
      >
        <CircleHelp size={14} /> Help
        {done === 0 && <span className="help__dot" aria-label="new" />}
      </button>

      {open && (
        <div className="help__menu" role="menu">
          <div className="help__head">
            <span>Guided tours</span>
            <span className="help__progress">
              {done} / {TOURS.length} done
            </span>
          </div>
          {TOURS.map((tour) => {
            const Icon = tour.icon
            const finished = completed.has(tour.id)
            return (
              <button
                key={tour.id}
                type="button"
                role="menuitem"
                className="help__item"
                data-done={finished}
                onClick={() => start(tour.id)}
              >
                <span className="help__icon">{finished ? <CheckCircle2 size={15} /> : <Icon size={15} />}</span>
                <span className="help__text">
                  <strong>{tour.title}</strong>
                  <small>
                    {tour.summary} · {tour.steps.length} steps
                  </small>
                </span>
                <ChevronRight size={14} className="help__chevron" />
              </button>
            )
          })}
          <div className="help__foot">
            <span>
              <kbd>?</kbd> opens this menu
            </span>
            {done > 0 && (
              <button type="button" className="help__reset" onClick={resetProgress} title="Forget which tours are done">
                <RotateCcw size={11} /> Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
