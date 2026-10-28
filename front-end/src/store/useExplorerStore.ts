/**
 * Single shared store for everything the canvas (AP-2) and the overlay/search (AP-3)
 * need to agree on: graph data, selection, focus mode, filters, overlay state.
 *
 * Deliberately one store so the two work packages never fight over state ownership
 * (risk flagged in section 7 of the hackathon brief).
 */

import { create } from 'zustand'

import { ApiError, api } from '../api/client'
import { mockGraph, mockModelDetail } from '../api/mock'
import type { GraphResponse, MetaResponse, ModelDetail } from '../api/types'
import type { LayoutMode } from '../graph/layout'
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

interface ExplorerState {
  status: Status
  errorMessage: string | null
  usingMock: boolean

  graph: GraphResponse | null
  meta: MetaResponse | null
  index: AdjacencyIndex

  filters: Filters
  layoutMode: LayoutMode
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

  // actions
  init: () => Promise<void>
  refresh: () => Promise<void>
  setFilters: (patch: Partial<Filters>) => Promise<void>
  setLayoutMode: (mode: LayoutMode) => void
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
}

const EMPTY_INDEX: AdjacencyIndex = {
  byId: new Map(),
  byName: new Map(),
  parents: new Map(),
  children: new Map(),
}

function computeHighlight(
  state: Pick<ExplorerState, 'graph' | 'index' | 'selectedIds' | 'activeId'>,
): { highlightedIds: Set<string>; highlightedEdgeIds: Set<string> } {
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
    await get().init()
  },

  setFilters: async (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch } }))
    await get().init()
  },

  setLayoutMode: (mode) => set({ layoutMode: mode }),
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
    set({ selectedIds: new Set(), selectorInput: '' })
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
}))

/** Selector helpers for components (keeps re-renders narrow). */
export const selectIsDimmed = (id: string) => (state: ExplorerState) => {
  if (state.focusMode === 'off') return false
  if (state.highlightedIds.size === 0) return false
  return !state.highlightedIds.has(id)
}
