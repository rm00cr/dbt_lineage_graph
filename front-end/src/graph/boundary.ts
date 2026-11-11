/**
 * Pipeline boundary convention: a pipeline is only read by other pipelines through its
 * outputs (models of its last layer, role out), and the consuming pipeline imports them
 * through a model of its first layer (role src). Layers: pipelines.yaml `layers`.
 *
 *   ok            out (pipeline A)  -> src (pipeline B)
 *   'internal'    int / src of A    -> any model of B      reads another pipeline's internals
 *   'skips-src'   out (pipeline A)  -> int / out of B      right model, but no src import
 *
 * dbt sources are external tables, not part of a pipeline's interface, so edges from them
 * never count as violations.
 */

import type { GraphEdge, GraphNode } from '../api/types'
import { roleOf } from './stage'

export type BoundaryViolation = 'internal' | 'skips-src'

export const VIOLATION_LABELS: Record<BoundaryViolation, string> = {
  internal: 'reads internals of another pipeline (only outputs may cross)',
  'skips-src': 'reads another pipeline’s output without importing it in its first layer',
}

export function boundaryViolation(edge: GraphEdge, nodesById: Map<string, GraphNode>): BoundaryViolation | null {
  const source = nodesById.get(edge.source)
  const target = nodesById.get(edge.target)
  if (!source || !target || source.pipeline === target.pipeline) return null
  if (source.resource_type === 'source') return null
  if (roleOf(source) !== 'out') return 'internal'
  if (roleOf(target) !== 'src') return 'skips-src'
  return null
}

/** edge id -> violation, for every cross-pipeline edge that breaks the convention */
export function boundaryViolations(nodes: GraphNode[], edges: GraphEdge[]): Map<string, BoundaryViolation> {
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  const result = new Map<string, BoundaryViolation>()
  for (const edge of edges) {
    const violation = boundaryViolation(edge, nodesById)
    if (violation) result.set(edge.id, violation)
  }
  return result
}
