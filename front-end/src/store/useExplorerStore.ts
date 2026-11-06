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
import type { GraphResponse, MetaResponse, ModelDetail, TraceDirection } from '../api/types'
import { type TraceView, buildTraceView } from '../graph/columnTrace'
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
export type OverlayTab = 'overview' | 'code' | 'schema' | 'lineage'
export type Status = 'loading' | 'ready' | 'error'

export interface Filters {
  pipelines: string[]
  stages: string[]
  includeSources: boolean
}

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

interface ExplorerState {
  status: Status
  errorMessage: string | null
  usingMock: boolean

  graph: GraphResponse | null
  meta: MetaResponse | null
  index: AdjacencyIndex

  filters: Filters
  layoutMode: LayoutMode
  /** which zones the 'lanes' layout draws: stage columns, dbt-group rows, or both */
  zoneMode: ZoneMode
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

  // actions
  init: () => Promise<void>
  refresh: () => Promise<void>
  setFilters: (patch: Partial<Filters>) => Promise<void>
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

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  status: 'loading',
  errorMessage: null,
  usingMock: false,

  graph: null,
  meta: null,
  index: EMPTY_INDEX,

  filters: { pipelines: [], stages: [], includeSources: true },
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

  // ------------------------------------------------------------------ loading
  init: async () => {
    set({ status: 'loading', errorMessage: null })
    const { filters } = get()

    try {
      const [graph, meta] = await Promise.all([
        api.graph({
          pipeline: filters.pipelines,
          stage: filters.stages,
          includeSources: filters.includeSources,
        }),
        api.meta().catch(() => null),
      ])

      set({
        graph,
        meta,
        index: buildIndex(graph.nodes, graph.edges),
        status: 'ready',
        usingMock: false,
        errorMessage: null,
      })
    } catch (error) {
      // AP-2/AP-3 can keep working offline against the mock graph.
      const message = error instanceof ApiError ? error.message : String(error)
      set({
        graph: mockGraph,
        meta: null,
        index: buildIndex(mockGraph.nodes, mockGraph.edges),
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
    const { detailCache, usingMock } = get()
    set({ activeId: id, detailError: null, overlayTab: options?.tab ?? 'overview' })
    set((state) => computeHighlight(state))
    if (options?.center !== false) get().requestCenter(id)

    const cached = detailCache.get(id)
    if (cached) {
      set({ detail: cached, detailLoading: false })
      return
    }

    if (usingMock) {
      const detail = mockModelDetail(id)
      set({ detail, detailLoading: false })
      set((state) => ({ detailCache: new Map(state.detailCache).set(id, detail) }))
      return
    }

    set({ detailLoading: true, detail: null })
    try {
      const detail = await api.model(id)
      if (get().activeId !== id) return // user moved on while we were loading
      set((state) => ({
        detail,
        detailLoading: false,
        detailCache: new Map(state.detailCache).set(id, detail),
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
}))

/** Selector helpers for components (keeps re-renders narrow). */
export const selectIsDimmed = (id: string) => (state: ExplorerState) => {
  if (state.focusMode === 'off') return false
  if (state.highlightedIds.size === 0) return false
  return !state.highlightedIds.has(id)
}
