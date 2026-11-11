import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode, Stage } from '../api/types'
import { allFolderKeys, collapseFolders, collapsedNodeId, folderKey } from './collapse'
import { layoutGraph } from './layout'

const node = (id: string, stage: Stage, folder: string | null, pipeline = 'p'): GraphNode => ({
  id,
  name: id,
  stage,
  materialization: 'table',
  pipeline,
  resource_type: 'model',
  group: null,
  folder,
  schema_name: null,
  database: null,
  description: null,
  tags: [],
  column_count: 0,
  execution_mode: null,
})
const edge = (source: string, target: string): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  cross_pipeline: false,
})

const nodes = [
  node('a1', 'int', 'statistic'),
  node('a2', 'int', 'statistic'),
  node('b', 'int', 'other'),
  node('o', 'out', 'mart'),
]
const edges = [edge('a1', 'a2'), edge('a1', 'b'), edge('a2', 'b'), edge('b', 'o')]

describe('collapseFolders', () => {
  const key = folderKey(nodes[0], false)

  it('changes nothing without collapsed folders', () => {
    const view = collapseFolders(nodes, edges, new Set(), false)
    expect(view.nodes).toBe(nodes)
    expect(view.edges).toBe(edges)
  })

  it('replaces the members by one summary node and merges the edges', () => {
    const view = collapseFolders(nodes, edges, new Set([key]), false)
    const id = collapsedNodeId(key)
    expect(view.nodes.map((n) => n.id).sort()).toEqual([id, 'b', 'o'].sort())
    expect(view.members.get(id)).toEqual(['a1', 'a2'])
    expect(view.representative.get('a2')).toBe(id)
    // a1->a2 vanishes, a1->b and a2->b become one edge
    expect(view.edges.map((e) => e.id).sort()).toEqual([`${id}=>b`, 'b->o'].sort())
    expect(view.edgeMembers.get(`${id}=>b`)).toEqual(['a1->b', 'a2->b'])
  })

  it('keeps a folder open when one of its nodes is pinned', () => {
    const view = collapseFolders(nodes, edges, new Set([key]), false, new Set(['a2']))
    expect(view.nodes).toHaveLength(4)
  })

  it('does not collapse unboxed sources', () => {
    const src = { ...node('s', 'src', null), resource_type: 'source' as const }
    const k = folderKey(src, false)
    expect(allFolderKeys([src], false)).toEqual([])
    expect(collapseFolders([src], [], new Set([k]), false).nodes).toEqual([src])
  })

  it('lays the summary node out inside the folder box and shrinks the stack', () => {
    const flat = edges.filter((e) => e.id !== 'a1->a2') // same sub-column, so the folder stacks
    const open = layoutGraph(nodes, flat, 'lanes', undefined, { zones: 'folders' })
    const view = collapseFolders(nodes, flat, new Set([key]), false)
    const closed = layoutGraph(view.nodes, view.edges, 'lanes', undefined, { zones: 'folders' })
    const box = closed.folders.find((f) => f.key === key)
    expect(box).toBeDefined()
    expect(closed.positions.has(collapsedNodeId(key))).toBe(true)
    expect(closed.lanes.find((l) => l.stage === 'int')!.height).toBeLessThan(open.lanes.find((l) => l.stage === 'int')!.height)
  })

  it('keys boxes per pipeline only when split', () => {
    const view = collapseFolders(nodes, edges, new Set(), true)
    expect(allFolderKeys(nodes, true).every((k) => k.startsWith('p|'))).toBe(true)
    expect(view.nodes).toBe(nodes)
  })
})
