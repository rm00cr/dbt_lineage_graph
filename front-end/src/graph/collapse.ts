/**
 * Collapsible folder boxes (zones view, 'folders' mode): every member of a collapsed folder is
 * replaced by ONE summary node, and edges to / from the members are re-pointed to it. The layout
 * then runs on the reduced graph, so the neighbours reflow and the picture gets smaller.
 */

import type { ChangeStatus, GraphEdge, GraphNode } from '../api/types'

export const COLLAPSED_PREFIX = '__folder__:'
export const COLLAPSED_NODE_HEIGHT = 112

/**
 * Identity of one folder box. Without a pipeline split a box spans all pipelines (stage +
 * folder); when split, every pipeline has its own box. Must match `FolderBand.key` in layout.ts.
 */
export function folderKey(n: Pick<GraphNode, 'pipeline' | 'stage' | 'folder'>, split: boolean): string {
  return `${split ? n.pipeline : ''}|${n.stage}|${n.folder ?? ''}`
}

/** Sources without a folder are drawn unboxed, so they cannot be collapsed. */
export function isCollapsible(n: GraphNode): boolean {
  return n.resource_type !== 'source' || Boolean(n.folder)
}

export const collapsedNodeId = (key: string) => `${COLLAPSED_PREFIX}${key}`
export const isCollapsedNodeId = (id: string) => id.startsWith(COLLAPSED_PREFIX)

export interface CollapsedView {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** summary node id -> ids of the real nodes it stands for */
  members: Map<string, string[]>
  /** view edge id -> ids of the real edges it stands for (only entries that differ from the id) */
  edgeMembers: Map<string, string[]>
  /** real node id -> id it is drawn as (itself, or its summary node) */
  representative: Map<string, string>
}

/**
 * `keep` lists real node ids that must stay visible even inside a collapsed folder (e.g. a
 * column trace needs its models); the folder is then left expanded as a whole.
 */
export function collapseFolders(
  nodes: GraphNode[],
  edges: GraphEdge[],
  collapsed: ReadonlySet<string>,
  split: boolean,
  keep: ReadonlySet<string> = new Set(),
): CollapsedView {
  const representative = new Map<string, string>(nodes.map((n) => [n.id, n.id]))
  const members = new Map<string, string[]>()
  const viewNodes: GraphNode[] = []

  if (collapsed.size === 0) {
    return { nodes, edges, members, edgeMembers: new Map(), representative }
  }

  const pinned = new Set<string>()
  for (const n of nodes) if (keep.has(n.id)) pinned.add(folderKey(n, split))

  const grouped = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    const key = folderKey(n, split)
    if (collapsed.has(key) && !pinned.has(key) && isCollapsible(n)) {
      grouped.set(key, [...(grouped.get(key) ?? []), n])
    } else {
      viewNodes.push(n)
    }
  }

  for (const [key, list] of grouped) {
    const id = collapsedNodeId(key)
    const first = list[0]
    members.set(id, list.map((n) => n.id))
    for (const n of list) representative.set(n.id, id)
    const changes = new Set(list.map((n) => n.change ?? 'unchanged'))
    viewNodes.push({
      id,
      name: first.folder ?? '(root)',
      stage: first.stage,
      materialization: 'other',
      pipeline: first.pipeline,
      resource_type: 'model',
      group: first.group ?? null,
      folder: first.folder ?? null,
      schema_name: null,
      database: null,
      description: null,
      tags: [],
      column_count: 0,
      execution_mode: null,
      change: changes.size === 1 && changes.has('unchanged') ? undefined : 'modified',
    })
  }

  const viewEdges: GraphEdge[] = []
  const merged = new Map<string, GraphEdge>()
  const edgeMembers = new Map<string, string[]>()
  for (const edge of edges) {
    const source = representative.get(edge.source)
    const target = representative.get(edge.target)
    if (source === undefined || target === undefined || source === target) continue
    if (source === edge.source && target === edge.target) {
      viewEdges.push(edge)
      continue
    }
    const id = `${source}=>${target}`
    const known = merged.get(id)
    if (known) {
      known.cross_pipeline ||= edge.cross_pipeline
      known.change = mergeChange(known.change, edge.change)
      edgeMembers.get(id)!.push(edge.id)
    } else {
      merged.set(id, { id, source, target, cross_pipeline: edge.cross_pipeline, change: edge.change })
      edgeMembers.set(id, [edge.id])
    }
  }
  viewEdges.push(...merged.values())

  return { nodes: viewNodes, edges: viewEdges, members, edgeMembers, representative }
}

function mergeChange(a: ChangeStatus | null | undefined, b: ChangeStatus | null | undefined) {
  return a === b ? a : 'modified'
}

/** Keys of every collapsible folder box in the graph. */
export function allFolderKeys(nodes: GraphNode[], split: boolean): string[] {
  return [...new Set(nodes.filter(isCollapsible).map((n) => folderKey(n, split)))]
}
