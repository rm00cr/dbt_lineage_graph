/**
 * What the canvas shows = what an export contains: the loaded (filtered) graph, narrowed to
 * the highlighted lineage while focus mode is "isolate".
 */

import type { GraphEdge, GraphNode, GraphResponse } from '../api/types'

export function visibleSubgraph(
  graph: GraphResponse | null,
  focusMode: 'off' | 'dim' | 'isolate',
  highlightedIds: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[]; ids: Set<string> } {
  if (!graph) return { nodes: [], edges: [], ids: new Set() }
  const isolating = focusMode === 'isolate' && highlightedIds.size > 0
  const nodes = isolating ? graph.nodes.filter((n) => highlightedIds.has(n.id)) : graph.nodes
  const ids = new Set(nodes.map((n) => n.id))
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  return { nodes, edges, ids }
}
