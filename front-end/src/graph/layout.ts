/**
 * Layout (AP-2): directed DAG layout via dagre, plus a "stage lanes" layout that lines the
 * nodes up in src / int / out columns (feature 3.2).
 */

import dagre from 'dagre'

import type { GraphEdge, GraphNode, Stage } from '../api/types'

export const NODE_WIDTH = 268
export const NODE_HEIGHT = 96

export type LayoutMode = 'dag' | 'lanes'
/** zones of the 'lanes' layout: stage columns, dbt-group rows, or both */
export type ZoneMode = 'stages' | 'both' | 'groups'
export const ZONE_MODES: ZoneMode[] = ['stages', 'both', 'groups']

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

/** Horizontal band for one dbt group (domain) in the lanes layout. */
export interface RowBand {
  /** null = nodes without a group */
  group: string | null
  x: number
  y: number
  width: number
  height: number
  count: number
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>
  lanes: LaneBox[]
  /** empty unless the graph has dbt groups */
  rows: RowBand[]
}

const STAGE_SEQUENCE: Stage[] = ['src', 'int', 'out', 'other']
const LANE_GAP = 140
const LANE_PADDING = 48
/** space above the first row for the stage labels */
const LANE_HEADER = 52
const ROW_GAP = 34
const SUB_COLUMN_GAP = 90
/** gap between DAG-depth columns in the groups-only layout */
const RANK_GAP = 110
/** left gutter that holds the vertical group labels */
const ROW_GUTTER = 56
/** vertical padding inside a group band, and gap between bands */
const ROW_PADDING = 22
const ROW_BAND_GAP = 18

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: LayoutMode = 'dag',
  /** per-node heights, e.g. nodes that show traced columns (2.3); default NODE_HEIGHT */
  heights?: Map<string, number>,
  /** which zones the 'lanes' layout draws */
  zones: ZoneMode = 'both',
): LayoutResult {
  if (nodes.length === 0) return { positions: new Map(), lanes: [], rows: [] }
  const heightOf = (id: string) => heights?.get(id) ?? NODE_HEIGHT
  return mode === 'lanes' ? layoutZones(nodes, edges, heightOf, zones) : layoutDag(nodes, edges, heightOf)
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

  return { positions, lanes: [], rows: [] }
}

/**
 * Depth of each node counting only edges that stay inside its own stage (longest path from a
 * stage-local root). E.g. raw_x -> src_x -> (int) gives raw_x depth 0 and src_x depth 1.
 */
function intraStageDepths(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const stageOf = new Map(nodes.map((n) => [n.id, n.stage]))
  return longestPathDepths(nodes, edges, (e) => stageOf.get(e.source) === stageOf.get(e.target))
}

/** Longest path from a root (node without counted parents); `counts` filters the edges. */
function longestPathDepths(
  nodes: GraphNode[],
  edges: GraphEdge[],
  counts: (edge: GraphEdge) => boolean = () => true,
): Map<string, number> {
  const present = new Set(nodes.map((n) => n.id))
  const parents = new Map<string, string[]>()
  for (const edge of edges) {
    if (!present.has(edge.source) || !present.has(edge.target) || edge.source === edge.target) continue
    if (!counts(edge)) continue
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

/** Key of the row for nodes without a dbt group. */
export const UNGROUPED = '__ungrouped__'

/**
 * Zone grid. Columns are the stages (src / int / out) and rows the dbt groups (domains);
 * `zones` switches either axis off:
 *  - 'stages': stage columns, one row
 *  - 'both':   stage columns x group rows
 *  - 'groups': group rows; columns are the DAG depth (dagre rank), no stage boxes
 *
 * Inside a stage, nodes are split into sub-columns by intra-stage depth so chains like
 * raw -> src flow left to right. Column x positions are shared by every row, so columns stay
 * aligned. Within a cell, nodes are ordered by the dagre layout, and rows are ordered by their
 * mean dagre y, both to keep edge crossings low. Without any groups there is a single row
 * and no row bands.
 */
function layoutZones(
  nodes: GraphNode[],
  edges: GraphEdge[],
  heightOf: (id: string) => number,
  zones: ZoneMode,
): LayoutResult {
  const dagLayout = layoutDag(nodes, edges, heightOf)
  const dagY = (id: string) => dagLayout.positions.get(id)?.y ?? 0
  const byStage = zones !== 'groups'
  const grouped = zones !== 'stages' && nodes.some((n) => n.group)
  const rowKey = (node: GraphNode) => (grouped ? (node.group ?? UNGROUPED) : '')

  // ------------------------------------------------------------------ columns (x)
  const gutter = grouped ? ROW_GUTTER : 0
  const columnOf = new Map<string, string>() // node id -> column key
  const columnX = new Map<string, number>() // column key -> x
  const lanes: LaneBox[] = []
  let laneX = gutter + LANE_PADDING

  if (byStage) {
    const depths = intraStageDepths(nodes, edges)
    for (const stage of STAGE_SEQUENCE) {
      const stageNodes = nodes.filter((n) => n.stage === stage)
      if (stageNodes.length === 0) continue
      const distinct = [...new Set(stageNodes.map((n) => depths.get(n.id) ?? 0))].sort((a, b) => a - b)
      distinct.forEach((d, i) => columnX.set(`${stage}:${d}`, laneX + i * (NODE_WIDTH + SUB_COLUMN_GAP)))
      for (const n of stageNodes) columnOf.set(n.id, `${stage}:${depths.get(n.id) ?? 0}`)
      const innerWidth = distinct.length * NODE_WIDTH + (distinct.length - 1) * SUB_COLUMN_GAP
      lanes.push({ stage, x: laneX - LANE_PADDING / 2, y: 0, width: innerWidth + LANE_PADDING, height: 0, count: stageNodes.length })
      laneX += innerWidth + LANE_GAP
    }
  } else {
    // longest-path depth from the roots (not dagre's ranks, which pull sources towards their
    // consumers), so every row starts with its sources on the left
    const depths = longestPathDepths(nodes, edges)
    const ranks = [...new Set(nodes.map((n) => depths.get(n.id) ?? 0))].sort((a, b) => a - b)
    ranks.forEach((r, i) => columnX.set(`rank:${r}`, laneX + i * (NODE_WIDTH + RANK_GAP)))
    for (const n of nodes) columnOf.set(n.id, `rank:${depths.get(n.id) ?? 0}`)
    laneX += ranks.length * (NODE_WIDTH + RANK_GAP) - RANK_GAP + LANE_GAP
  }
  const gridRight = laneX - LANE_GAP + LANE_PADDING / 2

  // ------------------------------------------------------------------ rows (y)
  const rowNodes = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const key = rowKey(node)
    rowNodes.set(key, [...(rowNodes.get(key) ?? []), node])
  }
  const meanY = (list: GraphNode[]) => list.reduce((sum, n) => sum + dagY(n.id), 0) / list.length
  const rowOrder = [...rowNodes.keys()].sort((a, b) => {
    if (a === UNGROUPED) return 1
    if (b === UNGROUPED) return -1
    return meanY(rowNodes.get(a)!) - meanY(rowNodes.get(b)!) || a.localeCompare(b)
  })

  const positions = new Map<string, { x: number; y: number }>()
  const rows: RowBand[] = []
  let rowTop = byStage ? LANE_HEADER : LANE_PADDING / 2
  for (const key of rowOrder) {
    const members = rowNodes.get(key)!
    const top = rowTop + (grouped ? ROW_PADDING : 0)

    // one stack per column
    const stacks = new Map<string, GraphNode[]>()
    for (const node of members) {
      const col = columnOf.get(node.id)!
      stacks.set(col, [...(stacks.get(col) ?? []), node])
    }
    let bottom = top
    for (const [col, stack] of stacks) {
      stack.sort((a, b) => dagY(a.id) - dagY(b.id) || a.name.localeCompare(b.name))
      const x = columnX.get(col) ?? 0
      let y = top
      for (const node of stack) {
        positions.set(node.id, { x, y })
        y += heightOf(node.id) + ROW_GAP
      }
      bottom = Math.max(bottom, y - ROW_GAP)
    }

    const height = bottom - rowTop + (grouped ? ROW_PADDING : 0)
    rows.push({ group: key === UNGROUPED ? null : key, x: 0, y: rowTop, width: gridRight, height, count: members.length })
    rowTop += height + (grouped ? ROW_BAND_GAP : 0)
  }

  const gridBottom = rowTop - (grouped ? ROW_BAND_GAP : 0) + LANE_PADDING / 2
  for (const lane of lanes) lane.height = Math.max(gridBottom, NODE_HEIGHT + LANE_PADDING * 2)

  return { positions, lanes, rows: grouped ? rows : [] }
}
