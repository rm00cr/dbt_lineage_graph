import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode, Stage } from '../api/types'
import { boundaryViolations } from './boundary'

const node = (id: string, stage: Stage, pipeline: string, resource_type: 'model' | 'source' = 'model'): GraphNode => ({
  id,
  name: id,
  stage,
  materialization: resource_type === 'source' ? 'source' : 'table',
  pipeline,
  resource_type,
  group: null,
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
  cross_pipeline: true,
})

const nodes = [
  node('a_raw', 'src', 'a', 'source'),
  node('a_src', 'src', 'a'),
  node('a_int', 'int', 'a'),
  node('a_out', 'out', 'a'),
  node('b_src', 'src', 'b'),
  node('b_int', 'int', 'b'),
  node('b_out', 'out', 'b'),
]

describe('boundaryViolations', () => {
  it('accepts out -> src across pipelines and anything inside a pipeline', () => {
    const edges = [edge('a_out', 'b_src'), edge('a_src', 'a_int'), edge('b_int', 'b_out')]
    expect(boundaryViolations(nodes, edges).size).toBe(0)
  })

  it('flags reading the internals of another pipeline', () => {
    const v = boundaryViolations(nodes, [edge('a_int', 'b_int'), edge('a_src', 'b_src')])
    expect([...v.values()]).toEqual(['internal', 'internal'])
  })

  it('flags reading an output without a src import', () => {
    const v = boundaryViolations(nodes, [edge('a_out', 'b_int'), edge('a_out', 'b_out')])
    expect([...v.values()]).toEqual(['skips-src', 'skips-src'])
  })

  it('uses the role of configured layers, not their names', () => {
    const custom = [
      { ...node('a_marts', 'marts', 'a'), role: 'out' as const },
      { ...node('b_staging', 'staging', 'b'), role: 'src' as const },
      { ...node('b_core', 'core', 'b'), role: 'int' as const },
    ]
    expect(boundaryViolations(custom, [edge('a_marts', 'b_staging')]).size).toBe(0)
    expect([...boundaryViolations(custom, [edge('a_marts', 'b_core')]).values()]).toEqual(['skips-src'])
  })

  it('never flags dbt sources (external tables)', () => {
    expect(boundaryViolations(nodes, [edge('a_raw', 'b_int')]).size).toBe(0)
  })
})
