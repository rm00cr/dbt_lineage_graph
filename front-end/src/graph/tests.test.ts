import { describe, expect, it } from 'vitest'

import type { GraphNode, GraphResponse, TestInfo } from '../api/types'
import {
  MAX_TEST_ROWS,
  TEST_NODE_GAP,
  placeTestNodes,
  TEST_LIST_PADDING,
  TEST_ROW_HEIGHT,
  testLabel,
  testListExtraHeight,
  visibleTests,
  withoutTestNodes,
} from './tests'

const generic = (column: string): TestInfo => ({
  name: `not_null_x_${column}`,
  kind: 'generic',
  test_name: 'not_null',
  column,
  severity: 'error',
})
const singular = (name: string): TestInfo => ({ name, kind: 'singular', severity: 'error' })

describe('testLabel', () => {
  it('shows generic tests as test(column) and dq checks by their name', () => {
    expect(testLabel(generic('pol_nr'))).toBe('not_null(pol_nr)')
    expect(testLabel(singular('dq_check_x_duplicate_check'))).toBe('dq_check_x_duplicate_check')
  })
})

describe('testListExtraHeight', () => {
  it('is zero when hidden, empty or absent', () => {
    expect(testListExtraHeight([generic('a')], false)).toBe(0)
    expect(testListExtraHeight([], true)).toBe(0)
    expect(testListExtraHeight(undefined, true)).toBe(0)
  })

  it('adds one row per visible test and a "+N more" line when cut off', () => {
    const three = [generic('a'), generic('b'), generic('c')]
    expect(testListExtraHeight(three, true)).toBe(TEST_LIST_PADDING + 3 * TEST_ROW_HEIGHT)

    const many = Array.from({ length: MAX_TEST_ROWS + 2 }, (_, i) => singular(`dq_${i}`))
    expect(visibleTests(many)).toHaveLength(MAX_TEST_ROWS)
    expect(testListExtraHeight(many, true)).toBe(
      TEST_LIST_PADDING + MAX_TEST_ROWS * TEST_ROW_HEIGHT + TEST_ROW_HEIGHT,
    )
  })
})

describe('withoutTestNodes', () => {
  const node = (id: string, resource_type: GraphNode['resource_type']): GraphNode => ({
    id, name: id, stage: 'int', materialization: resource_type === 'test' ? 'test' : 'table',
    pipeline: 'p', resource_type, schema_name: null, database: null, description: null,
    tags: [], column_count: 0, execution_mode: null,
  })
  const graph: GraphResponse = {
    nodes: [node('m1', 'model'), node('m2', 'model'), node('t1', 'test')],
    edges: [
      { id: 'm1->m2', source: 'm1', target: 'm2', cross_pipeline: false },
      { id: 'm1->t1', source: 'm1', target: 't1', cross_pipeline: false },
    ],
    stats: { node_count: 3, edge_count: 2, pipelines: ['p'], stages: ['int'], materializations: ['table', 'test'] },
  }

  it('drops test nodes and their edges, keeps the rest', () => {
    const hidden = withoutTestNodes(graph)
    expect(hidden.nodes.map((n) => n.id)).toEqual(['m1', 'm2'])
    expect(hidden.edges.map((e) => e.id)).toEqual(['m1->m2'])
    expect(hidden.stats.node_count).toBe(2)
  })

  it('returns the same graph when there are no test nodes', () => {
    const plain: GraphResponse = { ...graph, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1) }
    expect(withoutTestNodes(plain)).toBe(plain)
  })
})

describe('placeTestNodes', () => {
  const H = 124
  const W = 268
  it('puts a dq node under the model it reads, in its column, without overlapping', () => {
    const positions = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 400, y: 0 }],
    ])
    const edges = [{ source: 'a', target: 't1' }]
    const placed = placeTestNodes(['t1'], edges, positions, () => H, W, H)
    expect(placed.get('t1')!.x).toBe(0)
    expect(placed.get('t1')!.y).toBe(H + TEST_NODE_GAP)
  })

  it('stacks several checks on one model and keeps existing positions', () => {
    const positions = new Map([
      ['a', { x: 0, y: 0 }],
      ['below', { x: 0, y: H + TEST_NODE_GAP + H + 10 }],
    ])
    const edges = [{ source: 'a', target: 't1' }, { source: 'a', target: 't2' }]
    const placed = placeTestNodes(['t1', 't2'], edges, positions, () => H, W, H)
    const t1 = placed.get('t1')!
    const t2 = placed.get('t2')!
    expect(positions.get('a')).toEqual({ x: 0, y: 0 })
    // t1 cannot sit at the top of the free space, t2 goes below it or beyond the obstacle
    const overlapsBelow = (y: number) => y < H + TEST_NODE_GAP + H + 10 + H && y + H > H + TEST_NODE_GAP + H + 10
    expect(overlapsBelow(t1.y)).toBe(false)
    expect(overlapsBelow(t2.y)).toBe(false)
    expect(Math.abs(t1.y - t2.y)).toBeGreaterThanOrEqual(H)
  })
})
