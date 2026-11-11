/**
 * Renders the running guided tour (state in src/tour/useTourStore, content in src/tour/tours):
 * a spotlight around the step's target and a card placed next to it.
 *
 * The target is re-measured every frame, so the spotlight follows layout changes, the side
 * panel sliding in and a centring canvas. A target that is not on screen (yet) gets a centred
 * card instead.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useExplorerStore } from '../store/useExplorerStore'
import { type TourStep, tourById } from '../tour/tours'
import { useTourStore } from '../tour/useTourStore'

const PAD = 6 // spotlight padding around the target
const GAP = 12 // distance between spotlight and card
const MARGIN = 16 // distance to the viewport edge
const CARD_WIDTH = 360

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

/** the visible elements a step points at; several selectors are spotlighted together */
function resolveTargets(target: TourStep['target']): HTMLElement[] {
  const resolved = typeof target === 'function' ? target() : target
  if (!resolved) return []
  const selectors = Array.isArray(resolved) ? resolved : [resolved]
  const found: HTMLElement[] = []
  for (const selector of selectors) {
    let el: HTMLElement | null = null
    try {
      el = document.querySelector<HTMLElement>(selector)
    } catch {
      continue // invalid selector, e.g. from an unusual model id
    }
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) found.push(el)
  }
  return found
}

interface Box {
  top: number
  left: number
  right: number
  bottom: number
}

/** the smallest box around all of them */
export function unionRect(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  return {
    top: Math.min(...boxes.map((b) => b.top)),
    left: Math.min(...boxes.map((b) => b.left)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  }
}

function measure(els: HTMLElement[]): Rect | null {
  const r = unionRect(els.map((el) => el.getBoundingClientRect()))
  if (!r) return null
  // clip to the viewport: a target larger than the screen (the canvas) still gets a visible ring
  const top = Math.max(r.top - PAD, 2)
  const left = Math.max(r.left - PAD, 2)
  const bottom = Math.min(r.bottom + PAD, window.innerHeight - 2)
  const right = Math.min(r.right + PAD, window.innerWidth - 2)
  return { top, left, width: right - left, height: bottom - top }
}

/**
 * Steps' `enter`s run one after the other: a slow one (opening a model, tracing a column)
 * cannot finish after the user moved on and overwrite the state the current step set up.
 */
let enterChain: Promise<unknown> = Promise.resolve()

export function runEnter(step: TourStep, isCurrent: () => boolean): Promise<unknown> {
  enterChain = enterChain
    .then(() => (isCurrent() && step.enter ? step.enter() : undefined))
    .catch(() => undefined)
  return enterChain
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

/** below, above, left or right of the target, whichever fits first; else over its bottom edge */
export function placeCard(rect: Rect | null, w: number, h: number, vw: number, vh: number) {
  if (!rect) return { top: Math.max(MARGIN, (vh - h) / 2), left: (vw - w) / 2 }

  const fitsV = (top: number) => top >= MARGIN && top + h <= vh - MARGIN
  const fitsH = (left: number) => left >= MARGIN && left + w <= vw - MARGIN
  const alignedLeft = clamp(rect.left, MARGIN, vw - w - MARGIN)
  const alignedTop = clamp(rect.top, MARGIN, vh - h - MARGIN)

  const below = rect.top + rect.height + GAP
  if (fitsV(below)) return { top: below, left: alignedLeft }
  const above = rect.top - GAP - h
  if (fitsV(above)) return { top: above, left: alignedLeft }
  const leftOf = rect.left - GAP - w
  if (fitsH(leftOf)) return { top: alignedTop, left: leftOf }
  const rightOf = rect.left + rect.width + GAP
  if (fitsH(rightOf)) return { top: alignedTop, left: rightOf }
  // target fills the screen (the canvas): sit inside it, at the bottom
  return { top: clamp(rect.top + rect.height - h - MARGIN, MARGIN, vh - h - MARGIN), left: (vw - w) / 2 }
}

export function Tour() {
  const tourId = useTourStore((s) => s.tourId)
  const steps = useTourStore((s) => s.steps)
  const index = useTourStore((s) => s.index)
  const completed = useTourStore((s) => s.completed)
  const next = useTourStore((s) => s.next)
  const back = useTourStore((s) => s.back)
  const close = useTourStore((s) => s.close)
  const start = useTourStore((s) => s.start)
  const demo = useExplorerStore((s) => s.demo)

  const [rect, setRect] = useState<Rect | null>(null)
  const [size, setSize] = useState({ w: CARD_WIDTH, h: 200 })
  const cardRef = useRef<HTMLDivElement>(null)

  const tour = tourId ? tourById(tourId) : undefined
  const step = steps[index]
  const last = index === steps.length - 1
  const follow = tour?.next ? tourById(tour.next) : undefined

  // put the app in the state the step explains
  useEffect(() => {
    if (!step?.enter) return
    let current = true
    void runEnter(step, () => current)
    return () => {
      current = false
    }
  }, [step])

  // follow the target
  useLayoutEffect(() => {
    if (!step) return
    let scrolled = false
    let frame = 0
    const update = () => {
      const els = resolveTargets(step.target)
      if (els.length > 0 && !scrolled) {
        els[0].scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
        scrolled = true
      }
      const nextRect = measure(els)
      setRect((prev) => (sameRect(prev, nextRect) ? prev : nextRect))
      frame = window.requestAnimationFrame(update)
    }
    update()
    return () => window.cancelAnimationFrame(frame)
  }, [step])

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const w = card.offsetWidth || CARD_WIDTH
    const h = card.offsetHeight || 200
    if (w !== size.w || h !== size.h) setSize({ w, h })
  })

  // capture phase, so the canvas shortcuts (Esc clears the selection, F, L, ...) stay quiet
  useEffect(() => {
    if (!tourId) return
    const onKeyDown = (event: KeyboardEvent) => {
      const actions: Record<string, () => void> = {
        Escape: () => close(),
        ArrowRight: next,
        Enter: next,
        ArrowLeft: back,
      }
      const action = actions[event.key]
      event.stopPropagation()
      if (action) {
        event.preventDefault()
        action()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [tourId, next, back, close])

  useEffect(() => {
    if (tourId) cardRef.current?.focus({ preventScroll: true })
  }, [tourId, index])

  if (!tour || !step) return null

  const pos = placeCard(rect, size.w, size.h, window.innerWidth, window.innerHeight)
  const Icon = tour.icon

  return (
    <div
      className="tour"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      // menus close on a click outside them: one a step opened stays open under the tour
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {/* the app underneath is inert while touring; a stray click does not end the tour */}
      <div className={`tour__backdrop${rect ? '' : ' tour__backdrop--dim'}`} />
      {rect && <div className="tour__spotlight" style={rect} />}

      <div ref={cardRef} className="tour__card" style={pos} tabIndex={-1}>
        <div className="tour__head">
          <span className="tour__name">
            <Icon size={12} /> {tour.title}
          </span>
          {demo && (
            <span className="tour__demo" title="The tour runs on a demo project. Your project comes back when it ends.">
              Demo project
            </span>
          )}
          <span className="tour__count">
            {index + 1} / {steps.length}
          </span>
          <button type="button" className="icon-button" onClick={() => close()} aria-label="Close tour">
            <X size={14} />
          </button>
        </div>
        <h2 id="tour-title" className="tour__title">
          {step.title}
        </h2>
        <div className="tour__body">{step.body}</div>
        <div className="tour__progress" aria-hidden="true">
          <span style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
        </div>
        <div className="tour__actions">
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => close()}>
            {last ? 'Close' : 'Skip'}
          </button>
          <span className="tour__spacer" />
          <button type="button" className="btn btn--sm" onClick={back} disabled={index === 0}>
            <ChevronLeft size={13} /> Back
          </button>
          {last && follow && !completed.has(follow.id) ? (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => {
                close(true)
                start(follow.id)
              }}
              title={`Finish and start "${follow.title}"`}
            >
              Next: {follow.title} <ChevronRight size={13} />
            </button>
          ) : (
            <button type="button" className="btn btn--sm btn--primary" onClick={next}>
              {last ? 'Done' : 'Next'} {!last && <ChevronRight size={13} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
