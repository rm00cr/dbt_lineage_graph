/**
 * What the canvas shows = what an export contains:
 *
 *   1. the loaded (filtered) graph, with collapsed folder boxes replaced by one summary node
 *      each (zones layout, Groups) - see collapse.ts
 *   2. narrowed to the highlighted lineage while focus mode is "isolate"; a summary node
 *      counts as highlighted when any model it stands for is
 */

import type { GraphEdge, GraphNode, GraphResponse } from '../api/types'
import { type CollapsedView, collapseFolders } from './collapse'
import { type LayoutMode, type ZoneMode, effectiveZoneMode } from './layout'

const NONE: ReadonlySet<string> = new Set()

export interface ShownInput {
  graph: GraphResponse | null
  layoutMode: LayoutMode
  zoneMode: ZoneMode
  collapsedFolders: ReadonlySet<string>
  /** models that must stay visible (a column trace): their folders stay open */
  keep?: ReadonlySet<string>
}

/** The graph as drawn: collapsed folders folded into summary nodes. */
export function shownView({ graph, layoutMode, zoneMode, collapsedFolders, keep }: ShownInput): CollapsedView {
  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []
  // the zones layout gives every pipeline its own box once there are several (layout.ts)
  const split = new Set(nodes.map((n) => n.pipeline)).size > 1
  // folders only collapse where folder boxes are drawn (not in the "no sub-folders" fallback)
  const boxes = layoutMode === 'lanes' && effectiveZoneMode(zoneMode, nodes) === 'folders'
  return collapseFolders(nodes, edges, boxes ? collapsedFolders : NONE, split, keep ?? NONE)
}

/** A node - or a summary node through any model it stands for - is in `ids`. */
export function touches(view: Pick<CollapsedView, 'members'>, id: string, ids: ReadonlySet<string>): boolean {
  return view.members.get(id)?.some((m) => ids.has(m)) ?? ids.has(id)
}

export function visibleSubgraph(
  view: Pick<CollapsedView, 'nodes' | 'edges' | 'members'>,
  focusMode: 'off' | 'dim' | 'isolate',
  highlightedIds: ReadonlySet<string>,
): { nodes: GraphNode[]; edges: GraphEdge[]; ids: Set<string> } {
  const isolating = focusMode === 'isolate' && highlightedIds.size > 0
  const nodes = isolating ? view.nodes.filter((n) => touches(view, n.id, highlightedIds)) : view.nodes
  const ids = new Set(nodes.map((n) => n.id))
  const edges = view.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  return { nodes, edges, ids }
}
