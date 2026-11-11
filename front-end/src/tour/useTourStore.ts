/**
 * Guided tours: which tour runs, at which step, and which ones the user finished.
 *
 * Tours run on the demo project (api/mock: folders, execution modes, background jobs and a
 * comparison included), so every step has something to show whatever project is loaded.
 * Starting a tour snapshots the whole explorer state and swaps the demo in; closing it puts
 * the snapshot back as it was: a tour never leaves the user somewhere they did not navigate
 * to themselves.
 *
 * Finished tours are kept in localStorage, so the Help menu can tick them off.
 */

import { create } from 'zustand'

import { mockGraph, mockJobs, mockMeta, mockPipelineInfo } from '../api/mock'
import { DEFAULT_ZONE_MODE } from '../graph/layout'
import { buildIndex } from '../graph/selectors'
import { type ExplorerState, useExplorerStore } from '../store/useExplorerStore'
import { TOURS, type TourStep, tourById } from './tours'

const STORAGE_KEY = 'lineage-explorer.tours'

/** the data part of the explorer state (the actions never change) */
type Snapshot = Partial<ExplorerState>

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
  const state = useExplorerStore.getState()
  return Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== 'function')) as Snapshot
}

/** The explorer as the tours expect it: the demo project, nothing selected or open. */
export function demoState(now = Date.now()): Snapshot {
  return {
    status: 'ready',
    errorMessage: null,
    usingMock: true, // details, column lineage and search answer from the mock, polling pauses
    demo: true,
    graph: mockGraph,
    index: buildIndex(mockGraph.nodes, mockGraph.edges),
    meta: mockMeta,
    pipelineInfo: mockPipelineInfo,
    modeSwitching: null,
    modeError: null,
    jobs: mockJobs(now),
    jobsLoaded: true,
    jobNotices: [],
    unseenFailures: [],
    tasksOpen: false,
    pipelinesOpen: false,
    exportOpen: false,
    filtersOpen: false,
    filters: { pipelines: [], stages: [], includeSources: true },
    layoutMode: 'dag',
    zoneMode: DEFAULT_ZONE_MODE,
    collapsedFolders: new Set(),
    focusMode: 'dim',
    showMiniMap: true,
    selectionDrag: false,
    selectedIds: new Set(),
    highlightedIds: new Set(),
    highlightedEdgeIds: new Set(),
    selectorInput: '',
    activeId: null,
    overlayTab: 'overview',
    detail: null,
    detailLoading: false,
    detailError: null,
    detailCache: new Map(),
    columnTrace: null,
    compare: null,
    exporting: false,
    compareDialogOpen: false,
    compareLoading: false,
    compareError: null,
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
    useExplorerStore.setState(demoState())
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
    if (snapshot) useExplorerStore.setState(snapshot)
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
