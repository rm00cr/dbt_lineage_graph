/**
 * Single shared store for everything the canvas (AP-2) and the overlay/search (AP-3)
 * need to agree on: graph data, selection, focus mode, filters, overlay state.
 *
 * Deliberately one store so the two work packages never fight over state ownership
 * (risk flagged in section 7 of the hackathon brief).
 */

import { create } from 'zustand'

import { ApiError, api } from '../api/client'
import { mockColumnLineage, mockGraph, mockModelDetail } from '../api/mock'
import type {
  DiffResponse,
  GenerationJob,
  GraphResponse,
  MetaResponse,
  ModelDetail,
  NodeChange,
  PipelineInfo,
  TraceDirection,
} from '../api/types'
import { type TraceView, buildTraceView } from '../graph/columnTrace'
import { changedIds } from '../graph/diff'
import { type GraphFilters, filterGraph } from '../graph/filter'
import type { LayoutMode, ZoneMode } from '../graph/layout'
import {
  type AdjacencyIndex,
  buildIndex,
  edgesWithin,
  lineageClosure,
  resolveSelector,
  selectionToDbtSelector,
} from '../graph/selectors'

export type FocusMode = 'off' | 'dim' | 'isolate'
export type OverlayTab = 'overview' | 'code' | 'schema' | 'lineage' | 'changes'
export type Status = 'loading' | 'ready' | 'error'

export type Filters = GraphFilters

interface CenterRequest {
  id: string
  nonce: number
}

/** Column-level lineage trace (2.3). While `view` is set it drives the canvas highlight. */
export interface ColumnTrace {
  modelId: string
  column: string
  direction: TraceDirection
  view: TraceView | null
  warnings: string[]
  loading: boolean
  error: string | null
}

/**
 * State comparison: the running graph vs an uploaded manifest (+ catalog). While set, the
 * canvas shows the merged diff graph (`response.graph`) instead of the running one.
 */
export interface CompareState {
  stateId: string
  label: string
  response: DiffResponse
  changes: Map<string, NodeChange>
}

interface ExplorerState {
  status: Status
  errorMessage: string | null
  usingMock: boolean

  graph: GraphResponse | null
  meta: MetaResponse | null
  /** pipelines with their execution modes (GET /api/pipelines) */
  pipelineInfo: PipelineInfo[]
  /** pipeline whose execution mode is being switched */
  modeSwitching: string | null
  modeError: string | null
  /** background dbt runs (GET /api/jobs), newest first */
  jobs: GenerationJob[]
  /** false until the first poll: jobs finished before that are history, not news */
  jobsLoaded: boolean
  /** short-lived messages about finished jobs */
  jobNotices: JobNotice[]
  /** failed jobs the user has not looked at yet (red dot on the task indicator) */
  unseenFailures: string[]
  tasksOpen: boolean
  index: AdjacencyIndex

  filters: Filters
  layoutMode: LayoutMode
  /** which zones the 'lanes' layout draws: stage columns, dbt-group rows, or both */
  zoneMode: ZoneMode
  /** zones layout: one grid per pipeline, placed left to right by pipeline dependency */
  focusMode: FocusMode
  showMiniMap: boolean
  selectionDrag: boolean

  selectedIds: Set<string>
  highlightedIds: Set<string>
  highlightedEdgeIds: Set<string>
  selectorInput: string

  activeId: string | null
  overlayTab: OverlayTab
  detail: ModelDetail | null
  detailLoading: boolean
  detailError: string | null
  detailCache: Map<string, ModelDetail>

  centerRequest: CenterRequest | null
  columnTrace: ColumnTrace | null

  compare: CompareState | null
  /** true while an image export renders the canvas: nodes draw full detail at any zoom */
  exporting: boolean
  compareDialogOpen: boolean
  compareLoading: boolean
  compareError: string | null

  // actions
  init: () => Promise<void>
  refresh: () => Promise<void>
  setFilters: (patch: Partial<Filters>) => Promise<void>
  setPipelineMode: (pipeline: string, mode: string) => Promise<void>
  /** stacked execution modes: show `selected` modes of a pipeline, `front` in front */
  setPipelineModes: (pipeline: string, selected: string[], front: string) => Promise<void>
  /** a mode tab on the canvas: bring that (already stacked) mode of a pipeline to the front */
  bringModeToFront: (pipeline: string, mode: string) => Promise<void>
  /** run dbt for a pipeline in the background (`mode`: default the shown one) */
  regenerate: (pipeline: string, mode?: string | null) => Promise<void>
  pollJobs: () => Promise<void>
  /** poll /api/jobs - every 2 s while a job runs, else every 15 s. Returns the stop function. */
  startJobPolling: () => () => void
  setTasksOpen: (open: boolean) => void
  dismissNotice: (id: string) => void
  setLayoutMode: (mode: LayoutMode) => void
  setZoneMode: (mode: ZoneMode) => void
  setFocusMode: (mode: FocusMode) => void
  cycleFocusMode: () => void
  toggleMiniMap: () => void
  toggleSelectionDrag: () => void

  select: (ids: string[], options?: { additive?: boolean }) => void
  toggleSelected: (id: string) => void
  clearSelection: () => void
  applySelector: (input: string) => void
  setSelectorInput: (input: string) => void
  expandSelectionLineage: () => void
  dbtSelectorString: () => string

  openModel: (id: string, options?: { center?: boolean; tab?: OverlayTab }) => Promise<void>
  setOverlayTab: (tab: OverlayTab) => void
  closeOverlay: () => void
  requestCenter: (id: string) => void

  traceColumn: (modelId: string, column: string, direction?: TraceDirection) => Promise<void>
  setTraceDirection: (direction: TraceDirection) => Promise<void>
  clearColumnTrace: () => void

  setExporting: (exporting: boolean) => void
  setCompareDialogOpen: (open: boolean) => void
  startCompare: (manifest: File, catalog?: File | null, label?: string, pipeline?: string) => Promise<boolean>
  exitCompare: () => Promise<void>
  selectChanges: () => void
}

const EMPTY_INDEX: AdjacencyIndex = {
  byId: new Map(),
  byName: new Map(),
  parents: new Map(),
  children: new Map(),
}

function computeHighlight(
  state: Pick<ExplorerState, 'graph' | 'index' | 'selectedIds' | 'activeId' | 'columnTrace'>,
): { highlightedIds: Set<string>; highlightedEdgeIds: Set<string> } {
  const trace = state.columnTrace?.view
  if (trace) {
    return { highlightedIds: new Set(trace.nodeIds), highlightedEdgeIds: new Set(trace.modelEdgeIds) }
  }

  const seeds = new Set(state.selectedIds)
  if (state.activeId) seeds.add(state.activeId)

  if (!state.graph || seeds.size === 0) {
    return { highlightedIds: new Set(), highlightedEdgeIds: new Set() }
  }

  const closure = lineageClosure(state.index, seeds)
  return {
    highlightedIds: closure,
    highlightedEdgeIds: edgesWithin(state.graph.edges, closure),
  }
}

export interface JobNotice {
  id: string
  status: 'done' | 'failed'
  text: string
}

export const isActive = (job: GenerationJob) => job.status === 'queued' || job.status === 'running'

export const jobLabel = (job: Pick<GenerationJob, 'pipeline' | 'mode'>) =>
  job.mode ? `${job.pipeline} · ${job.mode}` : job.pipeline

/** the latest job of a pipeline / mode (jobs are newest first) */
export const latestJob = (jobs: GenerationJob[], pipeline: string, mode: string | null) =>
  jobs.find((job) => job.pipeline === pipeline && job.mode === mode)

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : String(error))

const replaceInfo = (list: PipelineInfo[], info: PipelineInfo) => list.map((p) => (p.name === info.name ? info : p))

/** The backend now serves other artifacts (mode switch, fresh dbt run): redraw everything. */
async function reloadShownGraph(get: () => ExplorerState) {
  // a comparison was made against the old artifacts: it no longer matches what is shown.
  // Otherwise refresh() drops cached details and reruns a column trace on the new graph.
  if (get().compare) await get().exitCompare()
  else await get().refresh()
  // an open overlay shows the old version: reload it (404 if the model is gone now)
  const { activeId, overlayTab } = get()
  if (activeId) void get().openModel(activeId, { tab: overlayTab, center: false })
}

// job polling: one timer for the app; kickJobPolling() polls right away (after starting a job)
let polling = false
let pollTimer: ReturnType<typeof setTimeout> | undefined
const POLL_BUSY_MS = 2000
const POLL_IDLE_MS = 15000

function kickJobPolling() {
  if (!polling) return
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    const store = useExplorerStore.getState()
    await store.pollJobs()
    if (!polling) return
    clearTimeout(pollTimer)
    const busy = useExplorerStore.getState().jobs.some(isActive)
    pollTimer = setTimeout(kickJobPolling, busy ? POLL_BUSY_MS : POLL_IDLE_MS)
  }, 0)
}

/** `?pipeline=a,b` is read before the first fetch so a shared link loads only those pipelines */
function pipelinesFromUrl(): string[] {
  if (typeof window === 'undefined') return []
  const raw = new URLSearchParams(window.location.search).get('pipeline')
  return raw ? raw.split(',').map((p) => p.trim()).filter(Boolean) : []
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  status: 'loading',
  errorMessage: null,
  usingMock: false,

  graph: null,
  meta: null,
  pipelineInfo: [],
  modeSwitching: null,
  modeError: null,
  jobs: [],
  jobsLoaded: false,
  jobNotices: [],
  unseenFailures: [],
  tasksOpen: false,
  index: EMPTY_INDEX,

  filters: { pipelines: pipelinesFromUrl(), stages: [], includeSources: true },
  layoutMode: 'dag',
  zoneMode: 'both',
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

  centerRequest: null,
  columnTrace: null,

  compare: null,
  exporting: false,
  compareDialogOpen: false,
  compareLoading: false,
  compareError: null,

  // ------------------------------------------------------------------ loading
  init: async () => {
    const { filters, compare } = get()

    // comparing: the diff graph is already here, only the filters need applying
    if (compare) {
      const graph = filterGraph(compare.response.graph, filters)
      set({ graph, index: buildIndex(graph.nodes, graph.edges), status: 'ready' })
      set((state) => computeHighlight(state))
      return
    }

    set({ status: 'loading', errorMessage: null })
    try {
      const [graph, meta, pipelineInfo] = await Promise.all([
        api.graph({
          pipeline: filters.pipelines,
          stage: filters.stages,
          includeSources: filters.includeSources,
        }),
        api.meta().catch(() => null),
        api.pipelines().catch(() => [] as PipelineInfo[]),
      ])

      set({
        graph,
        meta,
        pipelineInfo,
        index: buildIndex(graph.nodes, graph.edges),
        status: 'ready',
        usingMock: false,
        errorMessage: null,
      })
    } catch (error) {
      // AP-2/AP-3 can keep working offline against the mock graph.
      const message = error instanceof ApiError ? error.message : String(error)
      const graph = filterGraph(mockGraph, filters)
      set({
        graph,
        meta: null,
        pipelineInfo: [],
        index: buildIndex(graph.nodes, graph.edges),
        status: 'ready',
        usingMock: true,
        errorMessage: message,
      })
    }

    set((state) => computeHighlight(state))
  },

  refresh: async () => {
    set({ detailCache: new Map() })
    const trace = get().columnTrace
    await get().init()
    if (trace) await get().traceColumn(trace.modelId, trace.column, trace.direction)
  },

  setFilters: async (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch } }))
    await get().init()
  },

  setPipelineMode: async (pipeline, mode) => {
    const current = get().pipelineInfo.find((p) => p.name === pipeline)
    if (!current || current.active_mode === mode || get().modeSwitching) return
    set({ modeSwitching: pipeline, modeError: null })
    try {
      const info = await api.setPipelineMode(pipeline, mode)
      if (info.pending_mode) {
        // no artifacts yet: the backend generates them and switches once done (see pollJobs)
        set((state) => ({ pipelineInfo: replaceInfo(state.pipelineInfo, info), modeSwitching: null }))
        kickJobPolling()
        return
      }
      await reloadShownGraph(get)
      set({ modeSwitching: null })
    } catch (error) {
      set({ modeSwitching: null, modeError: errorText(error) })
    }
  },

  setPipelineModes: async (pipeline, selected, front) => {
    const current = get().pipelineInfo.find((p) => p.name === pipeline)
    if (!current || get().modeSwitching || selected.length === 0) return
    set({ modeSwitching: pipeline, modeError: null })
    try {
      const info = await api.setPipelineModes(pipeline, selected, front)
      set((state) => ({ pipelineInfo: replaceInfo(state.pipelineInfo, info) }))
      // missing modes are generated first and join once done (see pollJobs)
      if (info.pending_mode || info.modes.some((m) => selected.includes(m.name) && !m.available)) kickJobPolling()
      await reloadShownGraph(get)
      set({ modeSwitching: null })
    } catch (error) {
      set({ modeSwitching: null, modeError: errorText(error) })
    }
  },

  bringModeToFront: async (pipeline, mode) => {
    const info = get().pipelineInfo.find((p) => p.name === pipeline)
    if (!info?.active_mode || info.active_mode === mode) return
    const selected = [info.active_mode, ...(info.stacked_modes ?? [])]
    await get().setPipelineModes(pipeline, selected.includes(mode) ? selected : [...selected, mode], mode)
  },

  regenerate: async (pipeline, mode) => {
    set({ modeError: null })
    try {
      const info = await api.generatePipeline(pipeline, mode)
      set((state) => ({ pipelineInfo: replaceInfo(state.pipelineInfo, info) }))
      kickJobPolling()
    } catch (error) {
      set({ modeError: errorText(error) })
    }
  },

  pollJobs: async () => {
    if (get().usingMock) return
    let jobs: GenerationJob[]
    try {
      jobs = await api.jobs()
    } catch {
      return // backend away: try again on the next tick
    }
    const { jobs: before, jobsLoaded, jobNotices } = get()
    const previous = new Map(before.map((j) => [j.id, j]))
    const known = new Set(jobNotices.map((n) => n.id))
    // finished since the last poll: was running then, or started and ended in between
    const finished = jobs.filter((job) => {
      if (isActive(job) || known.has(job.id)) return false
      const old = previous.get(job.id)
      return old ? isActive(old) : jobsLoaded
    })
    set({ jobs, jobsLoaded: true })
    if (finished.length === 0) return

    // the backend has already switched / rebuilt; fetch the new mode state and redraw
    const pipelineInfo = await api.pipelines().catch(() => get().pipelineInfo)
    set({ pipelineInfo })
    const shown = (job: GenerationJob) => {
      const info = pipelineInfo.find((p) => p.name === job.pipeline)
      // the front mode, or a stacked back mode that just got its artifacts
      return job.mode === null || info?.active_mode === job.mode || Boolean(info?.stacked_modes?.includes(job.mode))
    }
    const redraw = finished.some((job) => job.status === 'done' && shown(job)) && !get().compare
    if (redraw) await reloadShownGraph(get)

    set((state) => ({
      jobNotices: [
        ...state.jobNotices,
        ...finished.map((job) => ({
          id: job.id,
          status: job.status as 'done' | 'failed',
          text:
            job.status === 'done'
              ? `${jobLabel(job)} generated${redraw && shown(job) ? ' - graph updated' : ''}`
              : `${jobLabel(job)}: dbt failed`,
        })),
      ],
      unseenFailures: state.tasksOpen
        ? state.unseenFailures
        : [...state.unseenFailures, ...finished.filter((j) => j.status === 'failed').map((j) => j.id)],
    }))
  },

  startJobPolling: () => {
    polling = true
    kickJobPolling()
    return () => {
      polling = false
      clearTimeout(pollTimer)
    }
  },

  setTasksOpen: (open) => set(open ? { tasksOpen: true, unseenFailures: [] } : { tasksOpen: false }),

  dismissNotice: (id) => set((state) => ({ jobNotices: state.jobNotices.filter((n) => n.id !== id) })),

  setLayoutMode: (mode) => set({ layoutMode: mode }),
  setZoneMode: (mode) => set({ zoneMode: mode }),
  setFocusMode: (mode) => set({ focusMode: mode }),
  cycleFocusMode: () =>
    set((state) => ({
      focusMode: state.focusMode === 'off' ? 'dim' : state.focusMode === 'dim' ? 'isolate' : 'off',
    })),
  toggleMiniMap: () => set((state) => ({ showMiniMap: !state.showMiniMap })),
  toggleSelectionDrag: () => set((state) => ({ selectionDrag: !state.selectionDrag })),

  // ------------------------------------------------------------------ selection
  select: (ids, options) => {
    const existing = options?.additive ? get().selectedIds : new Set<string>()
    const next = new Set(existing)
    for (const id of ids) {
      if (options?.additive && next.has(id)) next.delete(id)
      else next.add(id)
    }
    set({ selectedIds: next })
    set((state) => computeHighlight(state))
  },

  toggleSelected: (id) => get().select([id], { additive: true }),

  clearSelection: () => {
    set({ selectedIds: new Set(), selectorInput: '', columnTrace: null })
    set((state) => computeHighlight(state))
  },

  applySelector: (input) => {
    const { index } = get()
    const resolved = resolveSelector(index, input)
    set({ selectorInput: input, selectedIds: resolved })
    set((state) => computeHighlight(state))
  },

  setSelectorInput: (input) => set({ selectorInput: input }),

  expandSelectionLineage: () => {
    const { index, selectedIds, activeId } = get()
    const seeds = new Set(selectedIds)
    if (activeId) seeds.add(activeId)
    if (seeds.size === 0) return
    set({ selectedIds: lineageClosure(index, seeds) })
    set((state) => computeHighlight(state))
  },

  dbtSelectorString: () => {
    const { index, selectedIds, activeId } = get()
    const ids = selectedIds.size > 0 ? selectedIds : activeId ? [activeId] : []
    return selectionToDbtSelector(index, ids)
  },

  // ------------------------------------------------------------------ overlay
  openModel: async (id, options) => {
    const { detailCache, usingMock, compare } = get()
    // comparing: a changed node opens on what changed
    const defaultTab: OverlayTab = compare?.changes.has(id) ? 'changes' : 'overview'
    set({ activeId: id, detailError: null, overlayTab: options?.tab ?? defaultTab })
    set((state) => computeHighlight(state))
    if (options?.center !== false) get().requestCenter(id)

    // comparing: read the uploaded version of the node (the API falls back for removed ones)
    const cacheKey = compare ? `${compare.stateId}|${id}` : id
    const cached = detailCache.get(cacheKey)
    if (cached) {
      set({ detail: cached, detailLoading: false })
      return
    }

    if (usingMock) {
      const detail = mockModelDetail(id)
      set({ detail, detailLoading: false })
      set((state) => ({ detailCache: new Map(state.detailCache).set(cacheKey, detail) }))
      return
    }

    set({ detailLoading: true, detail: null })
    try {
      const detail = await api.model(id, compare?.stateId)
      if (get().activeId !== id) return // user moved on while we were loading
      set((state) => ({
        detail,
        detailLoading: false,
        detailCache: new Map(state.detailCache).set(cacheKey, detail),
      }))
    } catch (error) {
      if (get().activeId !== id) return
      set({
        detailLoading: false,
        detailError: error instanceof ApiError ? error.message : String(error),
      })
    }
  },

  setOverlayTab: (tab) => set({ overlayTab: tab }),

  closeOverlay: () => {
    set({ activeId: null, detail: null, detailError: null, detailLoading: false })
    set((state) => computeHighlight(state))
  },

  requestCenter: (id) =>
    set((state) => ({ centerRequest: { id, nonce: (state.centerRequest?.nonce ?? 0) + 1 } })),

  // ------------------------------------------------------------------ column lineage (2.3)
  traceColumn: async (modelId, column, direction = 'both') => {
    const previous = get().columnTrace
    set({
      columnTrace: {
        modelId,
        column,
        direction,
        // keep the old picture while the new one loads, so the canvas does not flash
        view: previous?.view ?? null,
        warnings: [],
        loading: true,
        error: null,
      },
    })

    const isCurrent = () => {
      const current = get().columnTrace
      return current?.modelId === modelId && current.column === column && current.direction === direction
    }

    try {
      const response = get().usingMock
        ? mockColumnLineage(modelId, column, direction)
        : await api.columnLineage(modelId, column, direction)
      if (!isCurrent()) return
      set({
        columnTrace: {
          modelId: response.root.model_id,
          column: response.root.column,
          direction,
          view: buildTraceView(response),
          warnings: response.warnings,
          loading: false,
          error: null,
        },
      })
    } catch (error) {
      if (!isCurrent()) return
      set({
        columnTrace: {
          modelId,
          column,
          direction,
          view: null,
          warnings: [],
          loading: false,
          error: error instanceof ApiError ? error.message : String(error),
        },
      })
    }
    set((state) => computeHighlight(state))
  },

  setTraceDirection: async (direction) => {
    const trace = get().columnTrace
    if (!trace || trace.direction === direction) return
    await get().traceColumn(trace.modelId, trace.column, direction)
  },

  clearColumnTrace: () => {
    if (!get().columnTrace) return
    set({ columnTrace: null })
    set((state) => computeHighlight(state))
  },

  setExporting: (exporting) => set({ exporting }),

  // ------------------------------------------------------------------ state comparison
  setCompareDialogOpen: (open) => set({ compareDialogOpen: open, compareError: open ? get().compareError : null }),

  startCompare: async (manifest, catalog, label, pipeline) => {
    if (get().usingMock) {
      set({ compareError: 'Comparing needs the backend: start it with `uv run lineage-api`.' })
      return false
    }
    set({ compareLoading: true, compareError: null })
    try {
      const response = await api.diff(manifest, catalog, label, pipeline)
      set({
        compare: {
          stateId: response.state_id,
          label: response.head.label,
          response,
          changes: new Map(response.changes.map((c) => [c.id, c])),
        },
        compareLoading: false,
        compareDialogOpen: false,
        // node ids and details differ between the states: start clean
        selectedIds: new Set(),
        selectorInput: '',
        columnTrace: null,
        activeId: null,
        detail: null,
        detailError: null,
        detailCache: new Map(),
      })
      await get().init()
      return true
    } catch (error) {
      set({ compareLoading: false, compareError: error instanceof ApiError ? error.message : String(error) })
      return false
    }
  },

  exitCompare: async () => {
    if (!get().compare) return
    set({
      compare: null,
      selectedIds: new Set(),
      selectorInput: '',
      activeId: null,
      detail: null,
      detailError: null,
      detailCache: new Map(),
    })
    await get().init()
  },

  selectChanges: () => {
    const { graph } = get()
    if (!graph) return
    set({ selectedIds: new Set(changedIds(graph.nodes)) })
    set((state) => computeHighlight(state))
  },
}))

/** Selector helpers for components (keeps re-renders narrow). */
export const selectIsDimmed = (id: string) => (state: ExplorerState) => {
  if (state.focusMode === 'off') return false
  if (state.highlightedIds.size === 0) return false
  return !state.highlightedIds.has(id)
}
