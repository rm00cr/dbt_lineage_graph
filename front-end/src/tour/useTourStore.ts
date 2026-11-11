/**
 * Guided tours: which tour runs, at which step, and which ones the user finished.
 *
 * Tours drive the app (open a model, switch tabs, trace a column, change the layout), so
 * starting one snapshots the explorer state and closing it puts that state back: a tour
 * never leaves the user somewhere they did not navigate to themselves.
 *
 * Finished tours are kept in localStorage, so the Help menu can tick them off.
 */

import { create } from 'zustand'

import { type ExplorerState, useExplorerStore } from '../store/useExplorerStore'
import { TOURS, type TourStep, tourById } from './tours'

const STORAGE_KEY = 'lineage-explorer.tours'

type Snapshot = Pick<
  ExplorerState,
  | 'activeId'
  | 'overlayTab'
  | 'columnTrace'
  | 'layoutMode'
  | 'zoneMode'
  | 'focusMode'
  | 'selectedIds'
  | 'selectorInput'
  | 'compareDialogOpen'
>

interface TourState {
  tourId: string | null
  /** steps of the running tour, filtered by their `when` at start */
  steps: TourStep[]
  index: number
  menuOpen: boolean
  completed: Set<string>

  start: (tourId: string) => void
  next: () => void
  back: () => void
  /** `finished`: the user reached the end (marks the tour done) */
  close: (finished?: boolean) => void
  setMenuOpen: (open: boolean) => void
  resetProgress: () => void
}

let snapshot: Snapshot | null = null

function loadCompleted(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveCompleted(completed: Set<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...completed]))
  } catch {
    // storage blocked: progress just does not survive a reload
  }
}

function takeSnapshot(): Snapshot {
  const s = useExplorerStore.getState()
  return {
    activeId: s.activeId,
    overlayTab: s.overlayTab,
    columnTrace: s.columnTrace,
    layoutMode: s.layoutMode,
    zoneMode: s.zoneMode,
    focusMode: s.focusMode,
    selectedIds: s.selectedIds,
    selectorInput: s.selectorInput,
    compareDialogOpen: s.compareDialogOpen,
  }
}

/** undo what the tour changed; only touches what differs, so nothing re-lays out for nothing */
function restore(snap: Snapshot) {
  const s = useExplorerStore.getState()
  if (s.compareDialogOpen !== snap.compareDialogOpen) s.setCompareDialogOpen(snap.compareDialogOpen)
  if (s.layoutMode !== snap.layoutMode) s.setLayoutMode(snap.layoutMode)
  if (s.zoneMode !== snap.zoneMode) s.setZoneMode(snap.zoneMode)
  if (s.focusMode !== snap.focusMode) s.setFocusMode(snap.focusMode)

  if (s.selectedIds !== snap.selectedIds) {
    if (snap.selectedIds.size > 0) s.select([...snap.selectedIds])
    else s.clearSelection()
  }
  // clearSelection also clears the selector field and the trace: restore those after it
  const now = useExplorerStore.getState()
  if (now.selectorInput !== snap.selectorInput) now.setSelectorInput(snap.selectorInput)

  const trace = snap.columnTrace
  if (!trace && now.columnTrace) now.clearColumnTrace()
  else if (trace && (now.columnTrace?.modelId !== trace.modelId || now.columnTrace.column !== trace.column)) {
    void now.traceColumn(trace.modelId, trace.column, trace.direction)
  }

  if (!snap.activeId) {
    if (now.activeId) now.closeOverlay()
  } else if (now.activeId !== snap.activeId) {
    void now.openModel(snap.activeId, { center: false, tab: snap.overlayTab })
  } else if (now.overlayTab !== snap.overlayTab) {
    now.setOverlayTab(snap.overlayTab)
  }
}

export const useTourStore = create<TourState>((set, get) => ({
  tourId: null,
  steps: [],
  index: 0,
  menuOpen: false,
  completed: loadCompleted(),

  start: (tourId) => {
    const tour = tourById(tourId)
    if (!tour) return
    if (get().tourId) get().close()
    snapshot = takeSnapshot()
    const steps = tour.steps.filter((step) => !step.when || step.when())
    set({ tourId, steps, index: 0, menuOpen: false })
  },

  next: () => {
    const { index, steps } = get()
    if (index >= steps.length - 1) get().close(true)
    else set({ index: index + 1 })
  },

  back: () => set((state) => ({ index: Math.max(0, state.index - 1) })),

  close: (finished = false) => {
    const { tourId, completed } = get()
    if (!tourId) return
    if (snapshot) restore(snapshot)
    snapshot = null
    if (finished && !completed.has(tourId)) {
      const next = new Set(completed).add(tourId)
      saveCompleted(next)
      set({ completed: next })
    }
    set({ tourId: null, steps: [], index: 0 })
  },

  setMenuOpen: (menuOpen) => set({ menuOpen }),

  resetProgress: () => {
    saveCompleted(new Set())
    set({ completed: new Set() })
  },
}))

export { TOURS }
