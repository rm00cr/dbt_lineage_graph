/**
 * Shareable views: `?model=<id>&tab=schema&layout=lanes&focus=isolate` is restored on load
 * and kept up to date, so a link can be pasted into a ticket or a chat.
 */

import { useEffect, useRef } from 'react'

import type { LayoutMode } from '../graph/layout'
import { type FocusMode, type OverlayTab, useExplorerStore } from '../store/useExplorerStore'

const TABS: OverlayTab[] = ['overview', 'code', 'schema', 'lineage']
const LAYOUTS: LayoutMode[] = ['dag', 'lanes']
const FOCUS: FocusMode[] = ['off', 'dim', 'isolate']

export function useUrlSync() {
  const status = useExplorerStore((s) => s.status)
  const graph = useExplorerStore((s) => s.graph)
  const activeId = useExplorerStore((s) => s.activeId)
  const overlayTab = useExplorerStore((s) => s.overlayTab)
  const layoutMode = useExplorerStore((s) => s.layoutMode)
  const focusMode = useExplorerStore((s) => s.focusMode)

  const restored = useRef(false)

  // restore once, as soon as the graph is there
  useEffect(() => {
    if (restored.current || status !== 'ready' || !graph) return
    restored.current = true

    const store = useExplorerStore.getState()
    const params = new URLSearchParams(window.location.search)

    const layout = params.get('layout') as LayoutMode | null
    if (layout && LAYOUTS.includes(layout)) store.setLayoutMode(layout)

    const focus = params.get('focus') as FocusMode | null
    if (focus && FOCUS.includes(focus)) store.setFocusMode(focus)

    const selector = params.get('select')
    if (selector) store.applySelector(selector)

    const wanted = params.get('model')
    if (!wanted) return

    const node =
      graph.nodes.find((n) => n.id === wanted) ??
      graph.nodes.find((n) => n.name.toLowerCase() === wanted.toLowerCase())
    if (!node) return

    const tab = params.get('tab') as OverlayTab | null
    if (!selector) store.select([node.id])
    void store.openModel(node.id, { tab: tab && TABS.includes(tab) ? tab : 'overview' })
  }, [status, graph])

  // write back
  useEffect(() => {
    if (!restored.current) return
    const url = new URL(window.location.href)
    const set = (key: string, value: string | null) =>
      value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value)

    set('model', activeId)
    set('tab', activeId && overlayTab !== 'overview' ? overlayTab : null)
    set('layout', layoutMode === 'dag' ? null : layoutMode)
    set('focus', focusMode === 'dim' ? null : focusMode)

    window.history.replaceState(null, '', url)
  }, [activeId, overlayTab, layoutMode, focusMode])
}
