import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode } from '../api/types'
import {
  buildIndex,
  edgesWithin,
  lineageClosure,
  parseSelectorToken,
  resolveSelector,
  selectionToDbtSelector,
  traverse,
} from './selectors'

/**
 *  src_a ─┐
 *         ├─> int_x ─> out_y ─> out_z
 *  src_b ─┘
 *  src_c ─> int_w ─> out_z         (int_w is in another pipeline)
 */
const node = (
  name: string,
  stage: GraphNode['stage'],
  materialization: GraphNode['materialization'],
  pipeline = 'p1',
  tags: string[] = [],
): GraphNode => ({
  id: `model.proj.${name}`,
  name,
  stage,
  materialization,
  pipeline,
  resource_type: 'model',
  schema_name: 'sch',
  database: 'db',
  description: null,
  tags,
  column_count: 0,
  execution_mode: null,
})

const NODES: GraphNode[] = [
  node('src_a', 'src', 'view', 'p1', ['core']),
  node('src_b', 'src', 'view', 'p1'),
  node('src_c', 'src', 'view', 'p2'),
  node('int_x', 'int', 'table', 'p1', ['core']),
  node('int_w', 'int', 'incremental', 'p2', ['core']),
  node('out_y', 'out', 'table', 'p1'),
  node('out_z', 'out', 'incremental', 'p1'),
]

const edge = (source: string, target: string): GraphEdge => ({
  id: `model.proj.${source}->model.proj.${target}`,
  source: `model.proj.${source}`,
  target: `model.proj.${target}`,
  cross_pipeline: false,
})

const EDGES: GraphEdge[] = [
  edge('src_a', 'int_x'),
  edge('src_b', 'int_x'),
  edge('int_x', 'out_y'),
  edge('out_y', 'out_z'),
  edge('src_c', 'int_w'),
  edge('int_w', 'out_z'),
]

const index = buildIndex(NODES, EDGES)
const id = (name: string) => `model.proj.${name}`
const names = (ids: Iterable<string>) =>
  [...ids].map((value) => value.replace('model.proj.', '')).sort()

describe('traverse', () => {
  it('walks upstream to the roots', () => {
    expect(names(traverse(index, [id('out_z')], 'up'))).toEqual([
      'int_w',
      'int_x',
      'out_y',
      'src_a',
      'src_b',
      'src_c',
    ])
  })

  it('walks downstream to the leaves', () => {
    expect(names(traverse(index, [id('src_a')], 'down'))).toEqual(['int_x', 'out_y', 'out_z'])
  })

  it('respects a depth limit', () => {
    expect(names(traverse(index, [id('out_z')], 'up', 1))).toEqual(['int_w', 'out_y'])
    expect(names(traverse(index, [id('out_z')], 'up', 2))).toEqual(['int_w', 'int_x', 'out_y', 'src_c'])
  })

  it('ignores unknown ids', () => {
    expect(traverse(index, ['nope'], 'up').size).toBe(0)
  })
})

describe('lineageClosure', () => {
  it('includes the node plus both directions', () => {
    expect(names(lineageClosure(index, [id('int_x')]))).toEqual([
      'int_x',
      'out_y',
      'out_z',
      'src_a',
      'src_b',
    ])
  })

  it('merges the closures of several seeds', () => {
    expect(names(lineageClosure(index, [id('src_a'), id('src_c')]))).toEqual([
      'int_w',
      'int_x',
      'out_y',
      'out_z',
      'src_a',
      'src_c',
    ])
  })
})

describe('edgesWithin', () => {
  it('keeps only edges with both ends inside the set', () => {
    const closure = lineageClosure(index, [id('int_x')])
    const highlighted = edgesWithin(EDGES, closure)
    expect(highlighted.has(edge('src_a', 'int_x').id)).toBe(true)
    expect(highlighted.has(edge('int_w', 'out_z').id)).toBe(false)
  })
})

describe('parseSelectorToken', () => {
  it('parses a bare name', () => {
    expect(parseSelectorToken('int_x')).toMatchObject({
      method: 'name',
      value: 'int_x',
      upstreamDepth: 0,
      downstreamDepth: 0,
    })
  })

  it('parses +model+', () => {
    expect(parseSelectorToken('+int_x+')).toMatchObject({
      value: 'int_x',
      upstreamDepth: Infinity,
      downstreamDepth: Infinity,
    })
  })

  it('parses one-sided operators', () => {
    expect(parseSelectorToken('+int_x')).toMatchObject({ upstreamDepth: Infinity, downstreamDepth: 0 })
    expect(parseSelectorToken('int_x+')).toMatchObject({ upstreamDepth: 0, downstreamDepth: Infinity })
  })

  it('parses numeric depths', () => {
    expect(parseSelectorToken('2+int_x')).toMatchObject({ upstreamDepth: 2, downstreamDepth: 0 })
    expect(parseSelectorToken('int_x+3')).toMatchObject({ upstreamDepth: 0, downstreamDepth: 3 })
  })

  it('parses selection methods', () => {
    expect(parseSelectorToken('tag:core')).toMatchObject({ method: 'tag', value: 'core' })
    expect(parseSelectorToken('stage:out')).toMatchObject({ method: 'stage', value: 'out' })
    expect(parseSelectorToken('pipeline:p2')).toMatchObject({ method: 'pipeline', value: 'p2' })
    expect(parseSelectorToken('config.materialized:table')).toMatchObject({
      method: 'materialization',
      value: 'table',
    })
  })

  it('returns null for empty input', () => {
    expect(parseSelectorToken('   ')).toBeNull()
  })
})

describe('resolveSelector', () => {
  it('resolves a single model', () => {
    expect(names(resolveSelector(index, 'int_x'))).toEqual(['int_x'])
  })

  it('resolves +model+ to the lineage path', () => {
    expect(names(resolveSelector(index, '+out_y+'))).toEqual(['int_x', 'out_y', 'out_z', 'src_a', 'src_b'])
  })

  it('resolves depth-limited upstream', () => {
    expect(names(resolveSelector(index, '1+out_y'))).toEqual(['int_x', 'out_y'])
  })

  it('unions space-separated selectors', () => {
    expect(names(resolveSelector(index, 'src_a src_c'))).toEqual(['src_a', 'src_c'])
  })

  it('intersects comma-separated selectors (dbt semantics)', () => {
    expect(names(resolveSelector(index, 'tag:core,stage:int'))).toEqual(['int_w', 'int_x'])
    expect(names(resolveSelector(index, 'tag:core,pipeline:p1'))).toEqual(['int_x', 'src_a'])
  })

  it('matches partial names', () => {
    expect(names(resolveSelector(index, 'out_'))).toEqual(['out_y', 'out_z'])
  })

  it('supports method selectors with graph operators', () => {
    expect(names(resolveSelector(index, 'stage:out+'))).toEqual(['out_y', 'out_z'])
    expect(names(resolveSelector(index, '+pipeline:p2'))).toEqual(['int_w', 'src_c'])
  })

  it('returns nothing for an unknown selector', () => {
    expect(resolveSelector(index, 'tag:does_not_exist').size).toBe(0)
    expect(resolveSelector(index, '').size).toBe(0)
  })
})

describe('selectionToDbtSelector', () => {
  it('produces a space-separated, sorted model list', () => {
    const selection = resolveSelector(index, '+out_y')
    expect(selectionToDbtSelector(index, selection)).toBe('int_x out_y src_a src_b')
  })

  it('skips ids that are not in the graph', () => {
    expect(selectionToDbtSelector(index, ['nope'])).toBe('')
  })
})
