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

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: LayoutMode = 'dag',
): LayoutResult {
  if (nodes.length === 0) return { positions: new Map(), lanes: [] }
  return mode === 'lanes' ? layoutLanes(nodes, edges) : layoutDag(nodes, edges)
}

/** Classic left-to-right dagre layout. */
function layoutDag(nodes: GraphNode[], edges: GraphEdge[]): LayoutResult {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 44, ranksep: 140, marginx: 40, marginy: 40, ranker: 'network-simplex' })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    const laid = g.node(node.id) as { x: number; y: number } | undefined
    positions.set(node.id, {
      x: (laid?.x ?? 0) - NODE_WIDTH / 2,
      y: (laid?.y ?? 0) - NODE_HEIGHT / 2,
    })
  }

  return { positions, lanes: [] }
}

/**
 * Stage lanes: x is driven by the stage, y by the dagre ordering inside the lane, so the
 * flow still reads left to right but the zones are visually crisp.
 */
function layoutLanes(nodes: GraphNode[], edges: GraphEdge[]): LayoutResult {
  const dagLayout = layoutDag(nodes, edges)
  const stagesPresent = STAGE_SEQUENCE.filter((stage) => nodes.some((n) => n.stage === stage))

  const positions = new Map<string, { x: number; y: number }>()
  const lanes: LaneBox[] = []

  stagesPresent.forEach((stage, laneIndex) => {
    const laneNodes = nodes
      .filter((node) => node.stage === stage)
      .sort((a, b) => {
        const ay = dagLayout.positions.get(a.id)?.y ?? 0
        const by = dagLayout.positions.get(b.id)?.y ?? 0
        if (ay !== by) return ay - by
        return a.name.localeCompare(b.name)
      })

    const x = LANE_PADDING + laneIndex * (NODE_WIDTH + LANE_GAP)

    laneNodes.forEach((node, rowIndex) => {
      positions.set(node.id, { x, y: LANE_PADDING + rowIndex * (NODE_HEIGHT + ROW_GAP) })
    })

    lanes.push({
      stage,
      x: x - LANE_PADDING / 2,
      y: 0,
      width: NODE_WIDTH + LANE_PADDING,
      height: Math.max(
        laneNodes.length * (NODE_HEIGHT + ROW_GAP) + LANE_PADDING * 2,
        NODE_HEIGHT + LANE_PADDING * 2,
      ),
      count: laneNodes.length,
    })
  })

  const tallest = Math.max(...lanes.map((lane) => lane.height), 0)
  for (const lane of lanes) lane.height = tallest

  return { positions, lanes }
}
