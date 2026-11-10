import { describe, expect, it } from 'vitest'

import type { GraphNode, GraphResponse } from '../api/types'
import { changedIds, parseUnifiedDiff } from './diff'
import { filterGraph } from './filter'

const node = (name: string, change: GraphNode['change'], pipeline = 'p1', stage: GraphNode['stage'] = 'int'): GraphNode => ({
  id: `model.proj.${name}`,
  name,
  stage,
  materialization: 'table',
  pipeline,
  resource_type: 'model',
  schema_name: null,
  database: null,
  description: null,
  tags: [],
  column_count: 0,
  execution_mode: null,
  change,
})

describe('parseUnifiedDiff', () => {
  it('numbers lines on both sides and types every line', () => {
    const diff = [
      '--- running/m.sql',
      '+++ uploaded/m.sql',
      '@@ -3,3 +3,4 @@',
      ' select a,',
      '-    b',
      '+    b,',
      '+    c',
      ' from x',
    ].join('\n')
    const lines = parseUnifiedDiff(diff)
    expect(lines.map((l) => l.kind)).toEqual(['file', 'file', 'hunk', 'context', 'del', 'add', 'add', 'context'])
    expect(lines[3]).toMatchObject({ text: 'select a,', oldNo: 3, newNo: 3 })
    expect(lines[4]).toMatchObject({ text: '    b', oldNo: 4, newNo: null })
    expect(lines[6]).toMatchObject({ text: '    c', oldNo: null, newNo: 5 })
    expect(lines[7]).toMatchObject({ oldNo: 5, newNo: 6 })
  })

  it('handles empty input and truncation notes', () => {
    expect(parseUnifiedDiff(null)).toEqual([])
    expect(parseUnifiedDiff('... 3 more diff lines not shown')[0].kind).toBe('note')
  })
})

describe('changedIds / filterGraph', () => {
  const graph: GraphResponse = {
    nodes: [node('a', 'unchanged'), node('b', 'added'), node('c', 'removed', 'p2'), node('d', 'modified', 'p2', 'out')],
    edges: [
      { id: 'a->b', source: 'model.proj.a', target: 'model.proj.b', cross_pipeline: false, change: 'added' },
      { id: 'a->c', source: 'model.proj.a', target: 'model.proj.c', cross_pipeline: true, change: 'removed' },
    ],
    stats: { node_count: 4, edge_count: 2, pipelines: ['p1', 'p2'], stages: ['int', 'out'], materializations: ['table'] },
  }

  it('lists only nodes that changed', () => {
    expect(changedIds(graph.nodes)).toEqual(['model.proj.b', 'model.proj.c', 'model.proj.d'])
  })

  it('applies the pipeline filter to a diff graph, keeping change flags', () => {
    const filtered = filterGraph(graph, { pipelines: ['p1'], stages: [], includeSources: true })
    expect(filtered.nodes.map((n) => n.name)).toEqual(['a', 'b'])
    expect(filtered.edges).toEqual([graph.edges[0]])
    expect(filtered.stats).toMatchObject({ node_count: 2, edge_count: 1, pipelines: ['p1'], stages: ['int'] })
  })
})
