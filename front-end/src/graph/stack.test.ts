import { describe, expect, it } from 'vitest'

import type { GraphNode } from '../api/types'
import { MAX_BACK_LAYERS, backLayers, isGhost, isStacked, stackTabs, tabDepth } from './stack'

const node = (patch: Partial<GraphNode>): GraphNode => ({
  id: 'model.p.x',
  name: 'x',
  stage: 'int',
  materialization: 'table',
  pipeline: 'p',
  resource_type: 'model',
  schema_name: null,
  database: null,
  description: null,
  tags: [],
  column_count: 0,
  execution_mode: null,
  ...patch,
})

describe('stack', () => {
  it('leaves single-mode pipelines alone', () => {
    const plain = node({})
    expect(isStacked(plain)).toBe(false)
    expect(stackTabs(plain)).toEqual([])
    expect(backLayers(plain)).toBe(0)
  })

  it('front card with back modes behind it', () => {
    const shared = node({ modes: ['full', 'incremental'], front: true, sql_differs: ['incremental'] })
    expect(isStacked(shared) && !isGhost(shared)).toBe(true)
    expect(stackTabs(shared)).toEqual([
      { mode: 'full', front: true, differs: false },
      { mode: 'incremental', front: false, differs: true },
    ])
    expect(backLayers(shared)).toBe(1)
    expect(backLayers(node({ modes: ['a', 'b', 'c', 'd'], front: true }))).toBe(MAX_BACK_LAYERS)
  })

  it('a model only in the front mode has no back cards', () => {
    const only = node({ modes: ['full'], front: true })
    expect(stackTabs(only)).toEqual([{ mode: 'full', front: true, differs: false }])
    expect(backLayers(only)).toBe(0)
  })

  it('a ghost has only back tabs and no back cards', () => {
    const ghost = node({ modes: ['incremental'], front: false })
    expect(isGhost(ghost)).toBe(true)
    expect(stackTabs(ghost)).toEqual([{ mode: 'incremental', front: false, differs: false }])
    expect(backLayers(ghost)).toBe(0)
  })
})

describe('tabDepth', () => {
  it('puts each tab on its own card, extra modes on the last back card', () => {
    const four = node({ modes: ['a', 'b', 'c', 'd'], front: true })
    expect([0, 1, 2, 3].map((i) => tabDepth(four, i))).toEqual([0, 1, MAX_BACK_LAYERS, MAX_BACK_LAYERS])
    const ghost = node({ modes: ['b', 'c'], front: false })
    expect([0, 1].map((i) => tabDepth(ghost, i))).toEqual([0, 0])
  })
})
