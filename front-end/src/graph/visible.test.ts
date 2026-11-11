import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode, GraphResponse, Stage } from '../api/types'
import { collapseFolders, collapsedNodeId, folderKey } from './collapse'
import { shownView, visibleSubgraph } from './visible'

const node = (id: string, stage: Stage, folder: string | null, patch: Partial<GraphNode> = {}): GraphNode => ({
  id,
  name: id,
  stage,
  materialization: 'table',
  pipeline: 'p',
  resource_type: 'model',
  folder,
  schema_name: null,
  database: null,
  description: null,
  tags: [],
  column_count: 0,
  execution_mode: null,
  ...patch,
})
const edge = (source: string, target: string, patch: Partial<GraphEdge> = {}): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  cross_pipeline: false,
  ...patch,
})
const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): GraphResponse => ({
  nodes,
  edges,
  stats: { node_count: nodes.length, edge_count: edges.length, pipelines: ['p'], stages: [], materializations: [] },
})

const folderNodes = [node('a1', 'int', 'claim'), node('a2', 'int', 'claim'), node('o', 'out', null)]
const folderEdges = [edge('a1', 'o'), edge('a2', 'o')]
const claim = folderKey(folderNodes[0], false)
const shown = (graph: GraphResponse, patch: Partial<Parameters<typeof shownView>[0]> = {}) =>
  shownView({ graph, layoutMode: 'lanes', zoneMode: 'folders', collapsedFolders: new Set([claim]), ...patch })

describe('shownView: what the canvas (and an export) shows', () => {
  it('collapses folders only where folder boxes are drawn', () => {
    const graph = graphOf(folderNodes, folderEdges)
    expect(shown(graph).members.get(collapsedNodeId(claim))).toEqual(['a1', 'a2'])
    expect(shown(graph, { layoutMode: 'dag' }).members.size).toBe(0)
    expect(shown(graph, { zoneMode: 'stages' }).members.size).toBe(0)
  })

  it('does not collapse in the "no sub-folders -> stages" fallback', () => {
    const flat = [node('x', 'int', null), node('y', 'out', null)]
    const view = shown(graphOf(flat, [edge('x', 'y')]), { collapsedFolders: new Set([folderKey(flat[0], false)]) })
    expect(view.nodes).toEqual(flat)
  })

  it('keeps a traced model visible', () => {
    expect(shown(graphOf(folderNodes, folderEdges), { keep: new Set(['a2']) }).members.size).toBe(0)
  })

  it('isolate keeps a summary node when one of its models is highlighted', () => {
    const view = shown(graphOf(folderNodes, folderEdges))
    const visible = visibleSubgraph(view, 'isolate', new Set(['a2']))
    expect(visible.nodes.map((n) => n.id)).toEqual([collapsedNodeId(claim)])
  })
})

describe('collapsed folders with stacked modes and comparison', () => {
  it('a merged edge is back-only (dashed) only if all its edges are', () => {
    const mixed = collapseFolders(folderNodes, [edge('a1', 'o', { front: false }), edge('a2', 'o')], new Set([claim]), false)
    expect(mixed.edges[0].front).toBe(true)
    const back = collapseFolders(folderNodes, [edge('a1', 'o', { front: false }), edge('a2', 'o', { front: false })], new Set([claim]), false)
    expect(back.edges[0].front).toBe(false)
  })

  it('a summary node takes the change of its models: alike -> that status, mixed -> modified', () => {
    const summary = (changes: GraphNode['change'][]) =>
      collapseFolders(
        folderNodes.map((n, i) => (i < 2 ? { ...n, change: changes[i] } : n)),
        folderEdges,
        new Set([claim]),
        false,
      ).nodes.find((n) => n.id === collapsedNodeId(claim))!.change
    expect(summary(['added', 'added'])).toBe('added')
    expect(summary(['removed', 'removed'])).toBe('removed')
    expect(summary(['added', 'unchanged'])).toBe('modified')
    expect(summary(['unchanged', 'unchanged'])).toBeUndefined()
  })
})
