/**
 * Client-side version of the `/api/graph` filters (pipeline / stage / sources).
 * Used for graphs the API does not filter for us: the offline mock and a state comparison.
 */

import type { GraphResponse } from '../api/types'

export interface GraphFilters {
  pipelines: string[]
  stages: string[]
  includeSources: boolean
}

export function filterGraph(graph: GraphResponse, filters: GraphFilters): GraphResponse {
  const nodes = graph.nodes.filter(
    (n) =>
      (!filters.pipelines.length || filters.pipelines.includes(n.pipeline)) &&
      (!filters.stages.length || filters.stages.includes(n.stage)) &&
      (filters.includeSources || n.resource_type !== 'source'),
  )
  const ids = new Set(nodes.map((n) => n.id))
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  return {
    nodes,
    edges,
    stats: {
      ...graph.stats,
      node_count: nodes.length,
      edge_count: edges.length,
      pipelines: graph.stats.pipelines.filter((p) => nodes.some((n) => n.pipeline === p)),
      groups: graph.stats.groups?.filter((g) => nodes.some((n) => n.group === g)),
      stages: graph.stats.stages.filter((s) => nodes.some((n) => n.stage === s)),
      materializations: graph.stats.materializations.filter((m) => nodes.some((n) => n.materialization === m)),
    },
  }
}
