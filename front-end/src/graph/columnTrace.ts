/**
 * Column-level lineage (2.3), frontend side: turns a `/api/lineage/column` response into
 * what the canvas needs: which nodes and model edges light up, and which column rows
 * each node shows. Pure functions, so they are easy to unit test.
 */

import type { ColumnEdgeKind, ColumnLineageEdge, ColumnLineageResponse } from '../api/types'

/** Column rows shown inside one node while tracing; the rest is summarised as "+N more". */
export const MAX_TRACE_ROWS = 8
export const TRACE_ROW_HEIGHT = 22
/** Space for the header and the "+N more" line of the column list inside a node. */
export const TRACE_LIST_PADDING = 12

export type TraceRole = 'root' | 'upstream' | 'downstream'

export interface TracedColumn {
  name: string
  role: TraceRole
  distance: number
}

export interface TraceView {
  root: { modelId: string; column: string }
  nodeIds: Set<string>
  /** model-level edge ids (`source->target`) that carry at least one traced column */
  modelEdgeIds: Set<string>
  columnsByNode: Map<string, TracedColumn[]>
  edges: ColumnLineageEdge[]
}

export const EDGE_KIND_LABELS: Record<ColumnEdgeKind, string> = {
  passthrough: 'passthrough',
  rename: 'rename',
  transform: 'transform',
  aggregate: 'aggregate',
}

const key = (model: string, column: string) => `${model}\u0000${column}`

export const rowHandleId = (column: string, side: 'in' | 'out') => `col:${side}:${column}`

/** Columns are traced through rows; anything beyond the visible ones goes through the node handle. */
export function visibleRows(columns: TracedColumn[]): TracedColumn[] {
  return columns.slice(0, MAX_TRACE_ROWS)
}

export function traceNodeHeight(baseHeight: number, columns: TracedColumn[] | undefined): number {
  if (!columns || columns.length === 0) return baseHeight
  return baseHeight + TRACE_LIST_PADDING + visibleRows(columns).length * TRACE_ROW_HEIGHT +
    (columns.length > MAX_TRACE_ROWS ? TRACE_ROW_HEIGHT : 0)
}

function reach(edges: ColumnLineageEdge[], start: string, upstream: boolean): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const from = upstream ? key(edge.target_model, edge.target_column) : key(edge.source_model, edge.source_column)
    const to = upstream ? key(edge.source_model, edge.source_column) : key(edge.target_model, edge.target_column)
    adjacency.set(from, [...(adjacency.get(from) ?? []), to])
  }
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

export function buildTraceView(trace: ColumnLineageResponse): TraceView {
  const rootKey = key(trace.root.model_id, trace.root.column)
  const upstream = reach(trace.edges, rootKey, true)
  const downstream = reach(trace.edges, rootKey, false)

  const columnsByNode = new Map<string, TracedColumn[]>()
  const nodeIds = new Set<string>()
  for (const node of trace.nodes) {
    const nodeKey = key(node.model_id, node.column)
    const role: TraceRole =
      nodeKey === rootKey ? 'root' : upstream.has(nodeKey) ? 'upstream' : downstream.has(nodeKey) ? 'downstream' : 'upstream'
    nodeIds.add(node.model_id)
    const list = columnsByNode.get(node.model_id) ?? []
    list.push({ name: node.column, role, distance: node.distance })
    columnsByNode.set(node.model_id, list)
  }

  const order: Record<TraceRole, number> = { root: 0, upstream: 1, downstream: 1 }
  for (const list of columnsByNode.values()) {
    list.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name))
  }

  const modelEdgeIds = new Set<string>()
  for (const edge of trace.edges) {
    if (edge.source_model !== edge.target_model) modelEdgeIds.add(`${edge.source_model}->${edge.target_model}`)
  }

  return {
    root: { modelId: trace.root.model_id, column: trace.root.column },
    nodeIds,
    modelEdgeIds,
    columnsByNode,
    edges: trace.edges,
  }
}

/**
 * Handle ids for one column edge: a row handle if the column is visible in its node,
 * otherwise `undefined` (React Flow then uses the node's default handle).
 */
export function edgeHandles(
  view: TraceView,
  edge: ColumnLineageEdge,
): { sourceHandle: string | undefined; targetHandle: string | undefined } {
  const visible = (model: string, column: string) =>
    visibleRows(view.columnsByNode.get(model) ?? []).some((c) => c.name === column)
  return {
    sourceHandle: visible(edge.source_model, edge.source_column) ? rowHandleId(edge.source_column, 'out') : undefined,
    targetHandle: visible(edge.target_model, edge.target_column) ? rowHandleId(edge.target_column, 'in') : undefined,
  }
}

/** `<model>|<column>`, the `col=` URL parameter. */
export function encodeTraceParam(modelId: string, column: string): string {
  return `${modelId}|${column}`
}

export function decodeTraceParam(value: string | null): { modelId: string; column: string } | null {
  if (!value) return null
  const split = value.lastIndexOf('|')
  if (split <= 0 || split === value.length - 1) return null
  return { modelId: value.slice(0, split), column: value.slice(split + 1) }
}
