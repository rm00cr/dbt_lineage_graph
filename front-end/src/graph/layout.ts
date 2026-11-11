/**
 * Layout (AP-2): directed DAG layout via dagre, plus a "stage lanes" layout that lines the
 * nodes up in one column per layer (pipelines.yaml `layers`, default src / int / out), every
 * pipeline in its own box (feature 3.2), and a "folders" zone mode that nests one box per
 * model sub-folder inside each stage column.
 */

import dagre from 'dagre'

import type { GraphEdge, GraphNode, Stage } from '../api/types'
import { orderStages } from './stage'

export const NODE_WIDTH = 268
/** height of a card with a long (three-line) name; the fallback where no node is known */
export const NODE_HEIGHT = 124

// card height follows the model name, which wraps at `_` and `.` (see ModelNode):
// padding + header + meta badges around max(icon row, name lines)
const CARD_CHROME = 55
const ICON_ROW = 23
export const NAME_LINE_HEIGHT = 18
export const MAX_NAME_LINES = 4
/** characters per name line; fewer while a compare tag sits next to the name */
const NAME_CHARS = 23
const NAME_CHARS_WITH_TAG = 12

/** How many lines `name` takes when wrapped at `_` / `.` with `perLine` characters a line. */
export function nameLines(name: string, perLine: number): number {
  let lines = 1
  let used = 0
  for (const part of name.split(/(?<=[_.])/)) {
    if (used > 0 && used + part.length > perLine) {
      lines += 1
      used = 0
    }
    if (part.length > perLine) {
      // no break point: the browser breaks the part anywhere
      lines += Math.ceil(part.length / perLine) - 1
      used = part.length % perLine || perLine
    } else {
      used += part.length
    }
  }
  return lines
}

/** Height of a node's card: short names get a compact card, long ones the lines they need. */
export function cardHeight(node: Pick<GraphNode, 'name' | 'change'>): number {
  const tagged = Boolean(node.change && node.change !== 'unchanged')
  const lines = Math.min(MAX_NAME_LINES, nameLines(node.name, tagged ? NAME_CHARS_WITH_TAG : NAME_CHARS))
  return CARD_CHROME + Math.max(ICON_ROW, lines * NAME_LINE_HEIGHT)
}

export type LayoutMode = 'dag' | 'lanes'
/**
 * zones of the 'lanes' layout: stage columns, dbt-group rows, both, or 'folders' (one box per
 * model sub-folder nested inside each stage column)
 */
export type ZoneMode = 'stages' | 'folders' | 'both' | 'groups'
export const ZONE_MODES: ZoneMode[] = ['stages', 'folders', 'both', 'groups']
export const DEFAULT_ZONE_MODE: ZoneMode = 'folders'

export interface Positioned {
  id: string
  x: number
  y: number
}

export interface LaneBox {
  stage: Stage
  /** the enclosing pipeline band; null with a single pipeline */
  pipeline: string | null
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
  /** the enclosing pipeline band; null with a single pipeline */
  pipeline: string | null
  x: number
  y: number
  width: number
  height: number
  count: number
}

/** Box for one model sub-folder inside a stage (folders zone mode). */
export interface FolderBand {
  /** identity for collapsing, see `folderKey` in collapse.ts */
  key: string
  stage: Stage
  /** null = models directly in the stage folder */
  folder: string | null
  /** the enclosing pipeline band; null with a single pipeline */
  pipeline: string | null
  x: number
  y: number
  width: number
  height: number
  count: number
}

/** Box around one pipeline's own grid (zones layout, 2+ pipelines). */
export interface PipelineBand {
  pipeline: string
  x: number
  y: number
  width: number
  height: number
  count: number
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>
  lanes: LaneBox[]
  /** group bands; empty unless group rows are shown */
  rows: RowBand[]
  /** folder boxes inside the stage lanes; empty unless the 'folders' zone mode is on */
  folders: FolderBand[]
  /** pipeline bands; empty with a single pipeline */
  pipelines: PipelineBand[]
}

export interface ZoneOptions {
  zones: ZoneMode
  /** the stage columns, left to right (meta `layers`); unknown stages follow, `other` last */
  stageOrder: Stage[]
}

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
/** pipeline bands: label strip on top, inner padding, vertical gap, horizontal gap */
const PIPE_HEADER = 40
const PIPE_PADDING = 18
const PIPE_GAP = 48
const PIPE_COLUMN_GAP = 170
/** folder boxes: label strip on top, inner side padding, vertical gap between boxes */
const FOLDER_HEADER = 30
const FOLDER_PADDING = 16
const FOLDER_GAP = 16

/**
 * The zone mode that is actually drawn: 'folders' needs at least one node with a model
 * sub-folder, else (a project that keeps models directly in the layer folders) it would
 * only show "(root)" boxes, so it falls back to plain stage columns.
 */
export function effectiveZoneMode(zones: ZoneMode, nodes: GraphNode[]): ZoneMode {
  return zones === 'folders' && !nodes.some((n) => n.folder) ? 'stages' : zones
}

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: LayoutMode = 'dag',
  /** per-node heights, e.g. nodes that show traced columns (2.3); default cardHeight(node) */
  heights?: Map<string, number>,
  /** what the 'lanes' (zones) layout draws */
  zoneOptions: Partial<ZoneOptions> = {},
): LayoutResult {
  if (nodes.length === 0) return { positions: new Map(), lanes: [], rows: [], folders: [], pipelines: [] }
  const cards = new Map(nodes.map((n) => [n.id, cardHeight(n)]))
  const heightOf = (id: string) => heights?.get(id) ?? cards.get(id) ?? NODE_HEIGHT
  const options: ZoneOptions = { zones: 'both', ...zoneOptions, stageOrder: zoneOptions.stageOrder ?? ['src', 'int', 'out'] }
  options.zones = effectiveZoneMode(options.zones, nodes)
  return mode === 'lanes' ? layoutZones(nodes, edges, heightOf, options) : layoutDag(nodes, edges, heightOf)
}

/** Classic left-to-right dagre layout. */
function layoutDag(nodes: GraphNode[], edges: GraphEdge[], heightOf: (id: string) => number): LayoutResult {
  const g = new dagre.graphlib.Graph()
  // tight, but with room for the compare rings (changed cards are drawn larger) and the
  // back cards of stacked execution modes (offset to the right)
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 90, marginx: 40, marginy: 40, ranker: 'network-simplex' })
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

  return { positions, lanes: [], rows: [], folders: [], pipelines: [] }
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

/** Pipeline-to-pipeline dependency graph (from cross-pipeline edges). */
function pipelineGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  const pipelineOf = new Map(nodes.map((n) => [n.id, n.pipeline]))
  const all = [...new Set(nodes.map((n) => n.pipeline))].sort()
  const downstream = new Map<string, Set<string>>(all.map((p) => [p, new Set()]))
  const upstream = new Map<string, Set<string>>(all.map((p) => [p, new Set()]))
  for (const edge of edges) {
    const from = pipelineOf.get(edge.source)
    const to = pipelineOf.get(edge.target)
    if (from === undefined || to === undefined || from === to) continue
    downstream.get(from)!.add(to)
    upstream.get(to)!.add(from)
  }
  return { all, downstream, upstream }
}

/**
 * Pipelines in dependency order (upstream first). Kahn's algorithm with alphabetical ties;
 * pipelines in a cycle are appended alphabetically.
 */
export function orderPipelines(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const { all, downstream } = pipelineGraph(nodes, edges)
  const indegree = new Map(all.map((p) => [p, 0]))
  for (const targets of downstream.values()) for (const t of targets) indegree.set(t, indegree.get(t)! + 1)

  const order: string[] = []
  const ready = all.filter((p) => indegree.get(p) === 0)
  while (ready.length > 0) {
    ready.sort()
    const next = ready.shift()!
    order.push(next)
    for (const t of downstream.get(next)!) {
      indegree.set(t, indegree.get(t)! - 1)
      if (indegree.get(t) === 0) ready.push(t)
    }
  }
  return [...order, ...all.filter((p) => !order.includes(p))]
}

/**
 * Column of each pipeline: the longest chain of upstream pipelines. Pipelines that do not
 * depend on each other share a column (stacked); a consumer sits right of all it reads from.
 */
function pipelineColumns(nodes: GraphNode[], edges: GraphEdge[], order: string[]): Map<string, number> {
  const { upstream } = pipelineGraph(nodes, edges)
  const column = new Map<string, number>()
  for (const p of order) {
    // upstream pipelines that come later in `order` are part of a cycle: ignored
    const parents = [...upstream.get(p)!].filter((q) => column.has(q))
    column.set(p, Math.max(-1, ...parents.map((q) => column.get(q)!)) + 1)
  }
  return column
}

/**
 * Wanted top of a pipeline band, given the bands of the pipelines it reads from: level with
 * a single upstream; below the lowest of several, so all their edges come in from the upper
 * left instead of one upstream sitting level and the others reaching across it.
 */
function bandTop(upstreams: PipelineBand[]): number {
  if (upstreams.length === 0) return 0
  if (upstreams.length === 1) return upstreams[0].y
  return Math.max(...upstreams.map((b) => b.y + b.height)) + PIPE_GAP
}

interface Block {
  positions: Map<string, { x: number; y: number }>
  lanes: LaneBox[]
  rows: RowBand[]
  folders: FolderBand[]
  width: number
  height: number
}

/**
 * One zone grid, relative to (0, 0). Columns are the stages (layers) or, without
 * stages, the DAG depth; rows are the dbt groups.
 *
 * Inside a stage, nodes are split into sub-columns by intra-stage depth so chains like
 * raw -> src flow left to right. Column x positions are shared by every row, so columns stay
 * aligned. Within a cell, nodes are ordered by the dagre layout, and rows are ordered by their
 * mean dagre y, both to keep edge crossings low.
 */
function layoutBlock(
  nodes: GraphNode[],
  edges: GraphEdge[],
  heightOf: (id: string) => number,
  dagY: (id: string) => number,
  byStage: boolean,
  grouped: boolean,
  pipeline: string | null,
  stageOrder: Stage[],
): Block {
  // ------------------------------------------------------------------ columns (x)
  const columnOf = new Map<string, string>() // node id -> column key
  const columnX = new Map<string, number>() // column key -> x
  const lanes: LaneBox[] = []
  let laneX = (grouped ? ROW_GUTTER : 0) + LANE_PADDING

  if (byStage) {
    const depths = intraStageDepths(nodes, edges)
    for (const stage of orderStages(new Set(nodes.map((n) => n.stage)), stageOrder)) {
      const stageNodes = nodes.filter((n) => n.stage === stage)
      if (stageNodes.length === 0) continue
      const distinct = [...new Set(stageNodes.map((n) => depths.get(n.id) ?? 0))].sort((a, b) => a - b)
      distinct.forEach((d, i) => columnX.set(`${stage}:${d}`, laneX + i * (NODE_WIDTH + SUB_COLUMN_GAP)))
      for (const n of stageNodes) columnOf.set(n.id, `${stage}:${depths.get(n.id) ?? 0}`)
      const innerWidth = distinct.length * NODE_WIDTH + (distinct.length - 1) * SUB_COLUMN_GAP
      lanes.push({
        stage,
        pipeline,
        x: laneX - LANE_PADDING / 2,
        y: 0,
        width: innerWidth + LANE_PADDING,
        height: 0,
        count: stageNodes.length,
      })
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
  const meanY = (list: GraphNode[]) => list.reduce((sum, n) => sum + dagY(n.id), 0) / list.length
  const rowNodes = bucket(nodes, (n) => (grouped ? (n.group ?? UNGROUPED) : ''))
  const rowOrder = [...rowNodes.keys()].sort((a, b) => {
    if (a === UNGROUPED) return 1
    if (b === UNGROUPED) return -1
    return meanY(rowNodes.get(a)!) - meanY(rowNodes.get(b)!) || a.localeCompare(b)
  })

  const positions = new Map<string, { x: number; y: number }>()
  const rows: RowBand[] = []
  let y = byStage ? LANE_HEADER : LANE_PADDING / 2
  for (const key of rowOrder) {
    const members = rowNodes.get(key)!
    const rowTop = y
    const top = rowTop + (grouped ? ROW_PADDING : 0)

    // one stack per column
    let bottom = top
    for (const [col, stack] of bucket(members, (n) => columnOf.get(n.id)!)) {
      stack.sort((a, b) => dagY(a.id) - dagY(b.id) || a.name.localeCompare(b.name))
      const x = columnX.get(col) ?? 0
      let stackY = top
      for (const node of stack) {
        positions.set(node.id, { x, y: stackY })
        stackY += heightOf(node.id) + ROW_GAP
      }
      bottom = Math.max(bottom, stackY - ROW_GAP)
    }

    const height = bottom - rowTop + (grouped ? ROW_PADDING : 0)
    if (grouped) {
      rows.push({
        group: key === UNGROUPED ? null : key,
        pipeline,
        x: 0,
        y: rowTop,
        width: gridRight,
        height,
        count: members.length,
      })
    }
    y += height + (grouped ? ROW_BAND_GAP : 0)
  }
  if (grouped) y -= ROW_BAND_GAP

  const gridBottom = Math.max(y + LANE_PADDING / 2, byStage ? NODE_HEIGHT + LANE_PADDING * 2 : 0)
  for (const lane of lanes) lane.height = gridBottom

  return { positions, lanes, rows, folders: [], width: gridRight, height: gridBottom }
}

/**
 * One zone grid for the 'folders' mode, relative to (0, 0): a box per stage (layer)
 * holding one box per sub-folder. Each folder is laid out on its own (dagre, left to right), so
 * a folder is only as wide as its own dependency chain. The boxes of a stage share one width,
 * so the stage lane stays a tidy column. A source sits in the folder of the models that read it
 * (the backend infers it). Folders are ordered by their mean dagre y; models and sources without
 * a folder sit in the "(root)" box, last.
 */
function layoutFolderBlock(
  nodes: GraphNode[],
  edges: GraphEdge[],
  heightOf: (id: string) => number,
  dagY: (id: string) => number,
  pipeline: string | null,
  stageOrder: Stage[],
): Block {
  const positions = new Map<string, { x: number; y: number }>()
  const lanes: LaneBox[] = []
  const folders: FolderBand[] = []
  const meanY = (list: GraphNode[]) => list.reduce((sum, n) => sum + dagY(n.id), 0) / list.length

  /** lay one folder's nodes out left to right, normalised to start at (0, 0) */
  const place = (members: GraphNode[]) => {
    const ids = new Set(members.map((n) => n.id))
    const inner = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
    const laid = layoutDag(members, inner, heightOf).positions
    const at = (n: GraphNode) => laid.get(n.id)!
    const minX = Math.min(...members.map((n) => at(n).x))
    const minY = Math.min(...members.map((n) => at(n).y))
    const maxX = Math.max(...members.map((n) => at(n).x + NODE_WIDTH))
    const maxY = Math.max(...members.map((n) => at(n).y + heightOf(n.id)))
    const local = new Map(members.map((n) => [n.id, { x: at(n).x - minX, y: at(n).y - minY }] as const))
    return { local, width: maxX - minX, height: maxY - minY }
  }

  let laneX = LANE_PADDING
  let gridBottom = 0
  for (const stage of orderStages(new Set(nodes.map((n) => n.stage)), stageOrder)) {
    const list = nodes.filter((n) => n.stage === stage)
    if (list.length === 0) continue

    // folders, ordered like the group rows; "(root)" last
    const byFolder = bucket(list, (n) => n.folder ?? UNGROUPED)
    const folderOrder = [...byFolder.keys()].sort((a, b) => {
      if (a === UNGROUPED) return 1
      if (b === UNGROUPED) return -1
      return meanY(byFolder.get(a)!) - meanY(byFolder.get(b)!) || a.localeCompare(b)
    })
    const placed = folderOrder.map((key) => ({ key, members: byFolder.get(key)!, ...place(byFolder.get(key)!) }))
    const innerWidth = Math.max(0, ...placed.map((p) => p.width))

    let y = LANE_HEADER
    for (const folder of placed) {
      const height = FOLDER_HEADER + folder.height + FOLDER_PADDING
      for (const [id, p] of folder.local) positions.set(id, { x: laneX + p.x, y: y + FOLDER_HEADER + p.y })
      folders.push({
        key: `${pipeline ?? ''}|${stage}|${folder.key === UNGROUPED ? '' : folder.key}`,
        stage,
        folder: folder.key === UNGROUPED ? null : folder.key,
        pipeline,
        x: laneX - FOLDER_PADDING,
        y,
        width: innerWidth + FOLDER_PADDING * 2,
        height,
        count: folder.members.length,
      })
      y += height + FOLDER_GAP
    }

    const stageBottom = y - FOLDER_GAP + LANE_PADDING / 2
    gridBottom = Math.max(gridBottom, stageBottom)
    lanes.push({ stage, pipeline, x: laneX - LANE_PADDING / 2, y: 0, width: innerWidth + LANE_PADDING, height: 0, count: list.length })
    laneX += innerWidth + LANE_GAP
  }

  // all stage boxes share one height, so the columns read as one grid
  const width = laneX - LANE_GAP + LANE_PADDING / 2
  const height = Math.max(gridBottom, NODE_HEIGHT + LANE_PADDING * 2)
  for (const lane of lanes) lane.height = height
  return { positions, lanes, rows: [], folders, width, height }
}

function bucket(list: GraphNode[], key: (n: GraphNode) => string): Map<string, GraphNode[]> {
  const map = new Map<string, GraphNode[]>()
  for (const n of list) map.set(key(n), [...(map.get(key(n)) ?? []), n])
  return map
}

/** Move a block by (dx, dy) and merge it into `into`. */
function placeBlock(block: Block, dx: number, dy: number, into: LayoutResult): void {
  for (const [id, p] of block.positions) into.positions.set(id, { x: p.x + dx, y: p.y + dy })
  for (const lane of block.lanes) into.lanes.push({ ...lane, x: lane.x + dx, y: lane.y + dy })
  for (const row of block.rows) into.rows.push({ ...row, x: row.x + dx, y: row.y + dy })
  for (const folder of block.folders) into.folders.push({ ...folder, x: folder.x + dx, y: folder.y + dy })
}

/**
 * Zones layout. `zones` picks the axes of the grid:
 *  - 'stages': stage columns, one row
 *  - 'both':   stage columns x group rows
 *  - 'groups': group rows; columns are the DAG depth (longest path), no stage boxes
 *  - 'folders': stage boxes, each holding one box per model sub-folder
 *
 * With 2+ pipelines, every pipeline gets its own grid inside a pipeline band. Assuming the
 * convention that only a pipeline's outputs feed other pipelines, the bands are placed like
 * a DAG: a consumer sits right of the pipelines it reads from (OUT -> SRC reads left to
 * right), and pipelines that do not depend on each other are stacked in the same column.
 * Vertically, a pipeline lines up with the one pipeline it reads from, and one that reads from
 * several starts below all of them (see `bandTop`).
 */
function layoutZones(
  nodes: GraphNode[],
  edges: GraphEdge[],
  heightOf: (id: string) => number,
  { zones, stageOrder }: ZoneOptions,
): LayoutResult {
  const dagLayout = layoutDag(nodes, edges, heightOf)
  const dagY = (id: string) => dagLayout.positions.get(id)?.y ?? 0
  const byStage = zones !== 'groups'
  // folders replace the dbt-group rows, so 'folders' never draws them
  const grouped = zones !== 'stages' && zones !== 'folders' && nodes.some((n) => n.group)
  const split = new Set(nodes.map((n) => n.pipeline)).size > 1

  const result: LayoutResult = { positions: new Map(), lanes: [], rows: [], folders: [], pipelines: [] }
  const buildBlock = (members: GraphNode[], inner: GraphEdge[], pipeline: string | null) =>
    zones === 'folders'
      ? layoutFolderBlock(members, inner, heightOf, dagY, pipeline, stageOrder)
      : layoutBlock(members, inner, heightOf, dagY, byStage, grouped, pipeline, stageOrder)

  if (!split) {
    placeBlock(buildBlock(nodes, edges, null), 0, 0, result)
    return result
  }

  const order = orderPipelines(nodes, edges)
  const columnOf = pipelineColumns(nodes, edges, order)
  const byPipeline = bucket(nodes, (n) => n.pipeline)
  const blocks = new Map<string, Block>()
  for (const p of order) {
    const members = byPipeline.get(p)!
    const ids = new Set(members.map((n) => n.id))
    const inner = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
    blocks.set(p, buildBlock(members, inner, p))
  }

  const { upstream } = pipelineGraph(nodes, edges)
  const placed = new Map<string, PipelineBand>()
  const columnCount = Math.max(...columnOf.values()) + 1
  let x = 0
  for (let col = 0; col < columnCount; col++) {
    const inColumn = order.filter((p) => columnOf.get(p) === col)
    if (inColumn.length === 0) continue
    const bandWidth = Math.max(...inColumn.map((p) => blocks.get(p)!.width)) + PIPE_PADDING * 2
    let free = 0 // top of the free space in this column
    for (const p of inColumn) {
      const block = blocks.get(p)!
      const bandHeight = PIPE_HEADER + block.height + PIPE_PADDING
      const y = Math.max(free, bandTop([...upstream.get(p)!].flatMap((q) => placed.get(q) ?? [])))
      placeBlock(block, x + PIPE_PADDING, y + PIPE_HEADER, result)
      const band = { pipeline: p, x, y, width: bandWidth, height: bandHeight, count: byPipeline.get(p)!.length }
      result.pipelines.push(band)
      placed.set(p, band)
      free = y + bandHeight + PIPE_GAP
    }
    x += bandWidth + PIPE_COLUMN_GAP
  }
  return result
}
