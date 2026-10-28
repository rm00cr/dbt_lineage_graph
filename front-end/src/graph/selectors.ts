/**
 * Graph traversal + dbt-style selector syntax (features 1.4 Focus Mode and 1.7 Multi-Selection).
 *
 * Supported selector grammar (a practical subset of `dbt ls --select`):
 *
 *   model_name          the node itself
 *   +model_name         model + all upstreams
 *   model_name+         model + all downstreams
 *   +model_name+        model + both directions
 *   2+model_name        2 upstream levels
 *   model_name+3        3 downstream levels
 *   tag:mfp             every node carrying the tag
 *   stage:out           every node of a stage
 *   pipeline:bestand_mfp
 *   materialization:incremental  (alias: config.materialized:incremental)
 *   a b                 union of both selectors            (dbt: space = union)
 *   a,b                 intersection of both selectors     (dbt: comma = intersection)
 */

import type { GraphEdge, GraphNode } from '../api/types'

export interface AdjacencyIndex {
  byId: Map<string, GraphNode>
  byName: Map<string, GraphNode>
  parents: Map<string, string[]>
  children: Map<string, string[]>
}

export function buildIndex(nodes: GraphNode[], edges: GraphEdge[]): AdjacencyIndex {
  const byId = new Map<string, GraphNode>()
  const byName = new Map<string, GraphNode>()
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()

  for (const node of nodes) {
    byId.set(node.id, node)
    byName.set(node.name.toLowerCase(), node)
    parents.set(node.id, [])
    children.set(node.id, [])
  }

  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    parents.get(edge.target)!.push(edge.source)
    children.get(edge.source)!.push(edge.target)
  }

  return { byId, byName, parents, children }
}

/** Breadth-first closure in one direction, optionally limited to `depth` levels. */
export function traverse(
  index: AdjacencyIndex,
  startIds: Iterable<string>,
  direction: 'up' | 'down',
  depth = Infinity,
): Set<string> {
  const map = direction === 'up' ? index.parents : index.children
  const seen = new Set<string>()
  let frontier = [...startIds].filter((id) => index.byId.has(id))
  let level = 0

  while (frontier.length > 0 && level < depth) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of map.get(id) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        next.push(neighbour)
      }
    }
    frontier = next
    level += 1
  }

  return seen
}

/** The node(s) plus their full upstream and downstream lineage — "the path". */
export function lineageClosure(index: AdjacencyIndex, ids: Iterable<string>): Set<string> {
  const seeds = [...ids]
  const closure = new Set<string>(seeds.filter((id) => index.byId.has(id)))
  for (const id of traverse(index, seeds, 'up')) closure.add(id)
  for (const id of traverse(index, seeds, 'down')) closure.add(id)
  return closure
}

/** Edges whose both ends are inside the set — used to highlight the lineage path. */
export function edgesWithin(edges: GraphEdge[], ids: Set<string>): Set<string> {
  const result = new Set<string>()
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) result.add(edge.id)
  }
  return result
}

// ---------------------------------------------------------------------------------------
// dbt selector syntax
// ---------------------------------------------------------------------------------------

export interface ParsedSelector {
  raw: string
  upstreamDepth: number // 0 = no upstream
  downstreamDepth: number
  method: 'name' | 'tag' | 'stage' | 'pipeline' | 'materialization'
  value: string
}

const METHOD_ALIASES: Record<string, ParsedSelector['method']> = {
  tag: 'tag',
  stage: 'stage',
  layer: 'stage',
  pipeline: 'pipeline',
  project: 'pipeline',
  materialization: 'materialization',
  materialized: 'materialization',
  'config.materialized': 'materialization',
}

const TOKEN_RE = /^(?:(\d*)\+)?(.*?)(?:\+(\d*))?$/

export function parseSelectorToken(token: string): ParsedSelector | null {
  const trimmed = token.trim()
  if (!trimmed) return null

  const match = TOKEN_RE.exec(trimmed)
  if (!match) return null

  const [, upRaw, body, downRaw] = match
  if (!body) return null

  const hasUp = trimmed.startsWith('+') || /^\d+\+/.test(trimmed)
  const hasDown = downRaw !== undefined

  let method: ParsedSelector['method'] = 'name'
  let value = body
  const colon = body.indexOf(':')
  if (colon > 0) {
    const candidate = METHOD_ALIASES[body.slice(0, colon).toLowerCase()]
    if (candidate) {
      method = candidate
      value = body.slice(colon + 1)
    }
  }

  return {
    raw: trimmed,
    upstreamDepth: hasUp ? (upRaw ? Number(upRaw) : Infinity) : 0,
    downstreamDepth: hasDown ? (downRaw ? Number(downRaw) : Infinity) : 0,
    method,
    value: value.trim(),
  }
}

function matchNodes(index: AdjacencyIndex, selector: ParsedSelector): string[] {
  const value = selector.value.toLowerCase()
  if (!value) return []

  if (selector.method === 'name') {
    const exact = index.byName.get(value)
    if (exact) return [exact.id]
    if (index.byId.has(selector.value)) return [selector.value]
    // tolerate partial names / wildcards: "mfp*" or "contracts"
    const needle = value.replace(/\*/g, '')
    return [...index.byId.values()].filter((n) => n.name.toLowerCase().includes(needle)).map((n) => n.id)
  }

  return [...index.byId.values()]
    .filter((node) => {
      switch (selector.method) {
        case 'tag':
          return node.tags.some((t) => t.toLowerCase() === value)
        case 'stage':
          return node.stage === value
        case 'pipeline':
          return node.pipeline.toLowerCase() === value
        case 'materialization':
          return node.materialization === value
        default:
          return false
      }
    })
    .map((node) => node.id)
}

/** Resolve one token including its +/- graph operators. */
export function resolveToken(index: AdjacencyIndex, token: string): Set<string> {
  const selector = parseSelectorToken(token)
  if (!selector) return new Set()

  const seeds = matchNodes(index, selector)
  const result = new Set<string>(seeds)

  if (selector.upstreamDepth > 0) {
    for (const id of traverse(index, seeds, 'up', selector.upstreamDepth)) result.add(id)
  }
  if (selector.downstreamDepth > 0) {
    for (const id of traverse(index, seeds, 'down', selector.downstreamDepth)) result.add(id)
  }

  return result
}

/**
 * Resolve a full selector string.
 * Space-separated parts are unioned, comma-separated parts intersected (as in dbt).
 */
export function resolveSelector(index: AdjacencyIndex, input: string): Set<string> {
  const union = new Set<string>()

  for (const group of input.split(/\s+/).filter(Boolean)) {
    const parts = group.split(',').filter(Boolean)

    // comma = intersection of the resolved parts
    const groupResult = parts
      .map((part) => resolveToken(index, part))
      .reduce<Set<string> | undefined>(
        (accumulated, current) =>
          accumulated === undefined
            ? current
            : new Set([...accumulated].filter((id) => current.has(id))),
        undefined,
      )

    for (const id of groupResult ?? []) union.add(id)
  }

  return union
}

/** Turn the current selection back into a copy-pasteable dbt selector string. */
export function selectionToDbtSelector(index: AdjacencyIndex, ids: Iterable<string>): string {
  const names = [...ids]
    .map((id) => index.byId.get(id))
    .filter((node): node is GraphNode => Boolean(node) && node!.resource_type === 'model')
    .map((node) => node.name)
    .sort()
  return names.join(' ')
}
