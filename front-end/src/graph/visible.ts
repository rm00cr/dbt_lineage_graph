/**
 * What the canvas shows = what an export contains:
 *
 *   1. the loaded (filtered) graph - singular-test nodes (dq checks) only while the Tests
 *      toggle is on - with collapsed folder boxes replaced by one summary node each (zones
 *      layout, Groups), see collapse.ts
 *   2. narrowed to the highlighted lineage while focus mode is "isolate"; a summary node
 *      counts as highlighted when any model it stands for is
 */

import type { GraphEdge, GraphNode, GraphResponse } from '../api/types'
import { type CollapsedView, collapseFolders } from './collapse'
import { type LayoutMode, type ZoneMode, effectiveZoneMode } from './layout'
import { withoutTestNodes } from './tests'

const NONE: ReadonlySet<string> = new Set()

export interface ShownInput {
  graph: GraphResponse | null
  layoutMode: LayoutMode
  zoneMode: ZoneMode
  collapsedFolders: ReadonlySet<string>
  splitPipelines: boolean
  /** models that must stay visible (a column trace): their folders stay open */
  keep?: ReadonlySet<string>
  /** Tests toggle: draw the singular-test (dq check) nodes */
  showTests?: boolean
}

/** The graph as drawn: collapsed folders folded into summary nodes. */
export function shownView({
  graph,
  layoutMode,
  zoneMode,
  collapsedFolders,
  splitPipelines,
  keep,
  showTests = false,
}: ShownInput): CollapsedView {
  const shownGraph = graph && withTestsFor(graph, showTests)
  const nodes = shownGraph?.nodes ?? []
  const edges = shownGraph?.edges ?? []
  const split = splitPipelines && new Set(nodes.map((n) => n.pipeline)).size > 1
  // folders only collapse where folder boxes are drawn (not in the "no sub-folders" fallback)
  const boxes = layoutMode === 'lanes' && effectiveZoneMode(zoneMode, nodes) === 'folders'
  return collapseFolders(nodes, edges, boxes ? collapsedFolders : NONE, split, keep ?? NONE)
}

/**
 * Test nodes are drawn under what they check, so a test is only shown with at least one
 * non-test node it reads (e.g. not when filters removed all of them); without the Tests
 * toggle, none are.
 */
function withTestsFor(graph: GraphResponse, showTests: boolean): GraphResponse {
  if (!showTests) return withoutTestNodes(graph)
  const kind = new Map(graph.nodes.map((n) => [n.id, n.resource_type]))
  const anchored = new Set(
    graph.edges.filter((e) => kind.get(e.target) === 'test' && kind.get(e.source) !== 'test').map((e) => e.target),
  )
  if (graph.nodes.every((n) => n.resource_type !== 'test' || anchored.has(n.id))) return graph
  const nodes = graph.nodes.filter((n) => n.resource_type !== 'test' || anchored.has(n.id))
  const ids = new Set(nodes.map((n) => n.id))
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  return { ...graph, nodes, edges, stats: { ...graph.stats, node_count: nodes.length, edge_count: edges.length } }
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
