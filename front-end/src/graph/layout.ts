/**
 * Layout (AP-2): directed DAG layout via dagre, plus a "stage lanes" layout that lines the
 * nodes up in src / int / out columns (feature 3.2).
 */

import dagre from 'dagre'

import type { GraphEdge, GraphNode, Stage } from '../api/types'

export const NODE_WIDTH = 268
export const NODE_HEIGHT = 96

export type LayoutMode = 'dag' | 'lanes'

export interface Positioned {
  id: string
  x: number
  y: number
}

export interface LaneBox {
  stage: Stage
  x: number
  y: number
  width: number
  height: number
  count: number
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>
  lanes: LaneBox[]
}

const STAGE_SEQUENCE: Stage[] = ['src', 'int', 'out', 'other']
const LANE_GAP = 140
const LANE_PADDING = 48
const ROW_GAP = 34
const SUB_COLUMN_GAP = 90

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: LayoutMode = 'dag',
  /** per-node heights, e.g. nodes that show traced columns (2.3); default NODE_HEIGHT */
  heights?: Map<string, number>,
): LayoutResult {
  if (nodes.length === 0) return { positions: new Map(), lanes: [] }
  const heightOf = (id: string) => heights?.get(id) ?? NODE_HEIGHT
  return mode === 'lanes' ? layoutLanes(nodes, edges, heightOf) : layoutDag(nodes, edges, heightOf)
}

/** Classic left-to-right dagre layout. */
function layoutDag(nodes: GraphNode[], edges: GraphEdge[], heightOf: (id: string) => number): LayoutResult {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 44, ranksep: 140, marginx: 40, marginy: 40, ranker: 'network-simplex' })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: heightOf(node.id) })
  for (const edge of edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    const laid = g.node(node.id) as { x: number; y: number } | undefined
    positions.set(node.id, {
      x: (laid?.x ?? 0) - NODE_WIDTH / 2,
      y: (laid?.y ?? 0) - heightOf(node.id) / 2,
    })
  }

  return { positions, lanes: [] }
}

/**
 * Depth of each node counting only edges that stay inside its own stage (longest path from a
 * stage-local root). E.g. raw_x -> src_x -> (int) gives raw_x depth 0 and src_x depth 1.
 */
function intraStageDepths(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const stageOf = new Map(nodes.map((n) => [n.id, n.stage]))
  const parents = new Map<string, string[]>()
  for (const edge of edges) {
    const s = stageOf.get(edge.source)
    if (s === undefined || s !== stageOf.get(edge.target) || edge.source === edge.target) continue
    const list = parents.get(edge.target) ?? []
    list.push(edge.source)
    parents.set(edge.target, list)
  }

  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0 // cycle guard
    visiting.add(id)
    const d = Math.max(-1, ...(parents.get(id) ?? []).map(visit)) + 1
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  for (const node of nodes) visit(node.id)
  return depth
}

/**
 * Stage lanes: each stage gets its own zone, split into sub-columns by intra-stage depth so
 * chains inside a stage (raw -> src, int -> int) flow left to right instead of stacking into
 * one tall column. Rows are ordered by the dagre layout to keep edge crossings low.
 */
function layoutLanes(nodes: GraphNode[], edges: GraphEdge[], heightOf: (id: string) => number): LayoutResult {
  const dagLayout = layoutDag(nodes, edges, heightOf)
  const depths = intraStageDepths(nodes, edges)
  const stagesPresent = STAGE_SEQUENCE.filter((stage) => nodes.some((n) => n.stage === stage))
  const dagY = (id: string) => dagLayout.positions.get(id)?.y ?? 0

  const positions = new Map<string, { x: number; y: number }>()
  const lanes: LaneBox[] = []

  let laneX = LANE_PADDING
  for (const stage of stagesPresent) {
    const laneNodes = nodes.filter((node) => node.stage === stage)

    // group into sub-columns by depth
    const columns: GraphNode[][] = []
    for (const node of laneNodes) {
      const d = depths.get(node.id) ?? 0
      ;(columns[d] ??= []).push(node)
    }
    const filled = columns.filter((col) => col && col.length > 0)

    let bottom = 0
    filled.forEach((col, colIndex) => {
      col.sort((a, b) => dagY(a.id) - dagY(b.id) || a.name.localeCompare(b.name))
      const x = laneX + colIndex * (NODE_WIDTH + SUB_COLUMN_GAP)
      let y = LANE_PADDING
      for (const node of col) {
        positions.set(node.id, { x, y })
        y += heightOf(node.id) + ROW_GAP
      }
      bottom = Math.max(bottom, y)
    })

    const innerWidth = filled.length * NODE_WIDTH + (filled.length - 1) * SUB_COLUMN_GAP
    lanes.push({
      stage,
      x: laneX - LANE_PADDING / 2,
      y: 0,
      width: innerWidth + LANE_PADDING,
      height: Math.max(bottom + LANE_PADDING, NODE_HEIGHT + LANE_PADDING * 2),
      count: laneNodes.length,
    })

    laneX += innerWidth + LANE_GAP
  }

  const tallest = Math.max(...lanes.map((lane) => lane.height), 0)
  for (const lane of lanes) lane.height = tallest

  return { positions, lanes }
}
