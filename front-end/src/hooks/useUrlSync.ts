/**
 * Shareable views: `?model=<id>&tab=schema&layout=lanes&focus=isolate` is restored on load
 * (`?pipeline=a,b` is read by the store itself, before the first fetch)
 * and kept up to date, so a link can be pasted into a ticket or a chat.
 */

import { useEffect, useRef } from 'react'

import type { TraceDirection } from '../api/types'
import { decodeTraceParam, encodeTraceParam } from '../graph/columnTrace'
import { DEFAULT_ZONE_MODE, type LayoutMode, ZONE_MODES, type ZoneMode } from '../graph/layout'
import { type FocusMode, type OverlayTab, useExplorerStore } from '../store/useExplorerStore'

// 'changes' only exists while comparing, which a link cannot restore
const TABS: OverlayTab[] = ['overview', 'code', 'schema', 'lineage']
const LAYOUTS: LayoutMode[] = ['dag', 'lanes']
const FOCUS: FocusMode[] = ['off', 'dim', 'isolate']
const DIRECTIONS: TraceDirection[] = ['up', 'down', 'both']

export function useUrlSync() {
  const status = useExplorerStore((s) => s.status)
  const graph = useExplorerStore((s) => s.graph)
  const activeId = useExplorerStore((s) => s.activeId)
  const overlayTab = useExplorerStore((s) => s.overlayTab)
  const layoutMode = useExplorerStore((s) => s.layoutMode)
  const zoneMode = useExplorerStore((s) => s.zoneMode)
  const focusMode = useExplorerStore((s) => s.focusMode)
  const pipelines = useExplorerStore((s) => s.filters.pipelines)
  const traceModel = useExplorerStore((s) => s.columnTrace?.modelId ?? null)
  const traceColumn = useExplorerStore((s) => s.columnTrace?.column ?? null)
  const traceDirection = useExplorerStore((s) => s.columnTrace?.direction ?? null)

  const demo = useExplorerStore((s) => s.demo)

  const restored = useRef(false)

  // restore once, as soon as the graph is there
  useEffect(() => {
    if (restored.current || status !== 'ready' || !graph) return
    restored.current = true

    const store = useExplorerStore.getState()
    const params = new URLSearchParams(window.location.search)

    const layout = params.get('layout') as LayoutMode | null
    if (layout && LAYOUTS.includes(layout)) store.setLayoutMode(layout)

    const zones = params.get('zones') as ZoneMode | null
    if (zones && ZONE_MODES.includes(zones)) store.setZoneMode(zones)

    const focus = params.get('focus') as FocusMode | null
    if (focus && FOCUS.includes(focus)) store.setFocusMode(focus)

    const selector = params.get('select')
    if (selector) store.applySelector(selector)

    const trace = decodeTraceParam(params.get('col'))
    if (trace) {
      const direction = params.get('coldir') as TraceDirection | null
      void store.traceColumn(trace.modelId, trace.column, direction && DIRECTIONS.includes(direction) ? direction : 'both')
    }

    const wanted = params.get('model')
    if (!wanted) return

    const node =
      graph.nodes.find((n) => n.id === wanted) ??
      graph.nodes.find((n) => n.name.toLowerCase() === wanted.toLowerCase())
    if (!node) return

    const tab = params.get('tab') as OverlayTab | null
    if (!selector) store.select([node.id])
    void store.openModel(node.id, {
      tab: tab && TABS.includes(tab) ? tab : 'overview',
      // a restored column trace frames its own path; don't fight it with a centre jump
      center: !trace,
    })
  }, [status, graph])

  // write back (not while a tour shows the demo project: its ids would end up in the link)
  useEffect(() => {
    if (!restored.current || demo) return
    const url = new URL(window.location.href)
    const set = (key: string, value: string | null) =>
      value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value)

    set('model', activeId)
    set('tab', activeId && overlayTab !== 'overview' && overlayTab !== 'changes' ? overlayTab : null)
    set('layout', layoutMode === 'dag' ? null : layoutMode)
    set('zones', layoutMode === 'lanes' && zoneMode !== DEFAULT_ZONE_MODE ? zoneMode : null)
    set('split', null) // retired: the zones layout always splits by pipeline
    set('pipeline', pipelines.length ? pipelines.join(',') : null)
    set('focus', focusMode === 'dim' ? null : focusMode)
    set('col', traceModel && traceColumn ? encodeTraceParam(traceModel, traceColumn) : null)
    set('coldir', traceModel && traceDirection !== 'both' ? traceDirection : null)

    window.history.replaceState(null, '', url)
  }, [demo, activeId, overlayTab, layoutMode, zoneMode, pipelines, focusMode, traceModel, traceColumn, traceDirection])
}
