import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode, Stage } from '../api/types'
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph, orderPipelines } from './layout'

const node = (id: string, stage: Stage, group: string | null = null, pipeline = 'p'): GraphNode => ({
  id,
  name: id,
  stage,
  materialization: 'table',
  pipeline,
  resource_type: 'model',
  group,
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

describe('lanes layout', () => {
  it('splits a stage into sub-columns by intra-stage depth', () => {
    const nodes = [node('raw', 'src'), node('stg', 'src'), node('int', 'int')]
    const { positions, rows } = layoutGraph(nodes, [edge('raw', 'stg'), edge('stg', 'int')], 'lanes')
    expect(positions.get('stg')!.x).toBeGreaterThan(positions.get('raw')!.x)
    expect(positions.get('int')!.x).toBeGreaterThan(positions.get('stg')!.x)
    expect(rows).toEqual([]) // no groups -> no bands
  })

  it('puts each dbt group in its own row with aligned stage columns', () => {
    const nodes = [
      node('a_src', 'src', 'claims'),
      node('a_out', 'out', 'claims'),
      node('b_src', 'src', 'contract'),
      node('b_out', 'out', 'contract'),
      node('loose', 'out', null),
    ]
    const edges = [edge('a_src', 'a_out'), edge('b_src', 'b_out'), edge('b_src', 'loose')]
    const { positions, rows } = layoutGraph(nodes, edges, 'lanes')

    expect(rows.map((r) => r.group).slice(-1)).toEqual([null]) // ungrouped row last
    expect(new Set(rows.map((r) => r.group))).toEqual(new Set(['claims', 'contract', null]))

    // same stage -> same x across rows
    expect(positions.get('a_src')!.x).toBe(positions.get('b_src')!.x)
    expect(positions.get('a_out')!.x).toBe(positions.get('b_out')!.x)

    // every node sits inside its own band, bands don't overlap
    for (const row of rows) {
      for (const n of nodes.filter((x) => (x.group ?? null) === row.group)) {
        const p = positions.get(n.id)!
        expect(p.y).toBeGreaterThanOrEqual(row.y)
        expect(p.y + NODE_HEIGHT).toBeLessThanOrEqual(row.y + row.height)
        expect(p.x + NODE_WIDTH).toBeLessThanOrEqual(row.x + row.width)
      }
    }
    const sorted = [...rows].sort((a, b) => a.y - b.y)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].height)
    }
  })

  const grouped = [node('a_src', 'src', 'claims'), node('a_out', 'out', 'claims'), node('b_src', 'src', 'contract')]
  const groupedEdges = [edge('a_src', 'a_out')]

  it("'stages' ignores groups", () => {
    const { lanes, rows } = layoutGraph(grouped, groupedEdges, 'lanes', undefined, { zones: 'stages' })
    expect(lanes.map((l) => l.stage)).toEqual(['src', 'out'])
    expect(rows).toEqual([])
  })

  it("'groups' draws group rows without stage lanes, columns by DAG depth", () => {
    const { positions, lanes, rows } = layoutGraph(grouped, groupedEdges, 'lanes', undefined, { zones: 'groups' })
    expect(lanes).toEqual([])
    expect(new Set(rows.map((r) => r.group))).toEqual(new Set(['claims', 'contract']))
    expect(positions.get('a_out')!.x).toBeGreaterThan(positions.get('a_src')!.x)
    expect(positions.get('a_src')!.y).not.toBe(positions.get('b_src')!.y)
  })

  describe('one box per pipeline', () => {
    // convention: only outputs cross pipelines, into a src model.
    // 'zz_up' feeds 'aa_down' (alphabetical order would put aa_down first); 'mm_solo' is independent
    const multi = [
      node('u_src', 'src', 'contract', 'zz_up'),
      node('u_out', 'out', 'contract', 'zz_up'),
      node('d_src', 'src', 'claims', 'aa_down'),
      node('d_int', 'int', 'claims', 'aa_down'),
      node('d_fin', 'out', 'finance', 'aa_down'),
      node('s_src', 'src', null, 'mm_solo'),
      node('s_out', 'out', null, 'mm_solo'),
    ]
    const multiEdges = [
      edge('u_src', 'u_out'),
      edge('u_out', 'd_src'),
      edge('d_src', 'd_int'),
      edge('d_int', 'd_fin'),
      edge('s_src', 's_out'),
    ]
    const split = () => layoutGraph(multi, multiEdges, 'lanes', undefined, { zones: 'both' })
    const band = (result: ReturnType<typeof split>, p: string) => result.pipelines.find((b) => b.pipeline === p)!

    it('orders pipelines upstream first', () => {
      expect(orderPipelines(multi, multiEdges)).toEqual(['mm_solo', 'zz_up', 'aa_down'])
    })

    it('places a consuming pipeline right of its upstream, so OUT -> SRC flows left to right', () => {
      const result = split()
      const up = band(result, 'zz_up')
      const down = band(result, 'aa_down')
      expect(down.x).toBeGreaterThan(up.x + up.width)
      expect(result.positions.get('d_src')!.x).toBeGreaterThan(result.positions.get('u_out')!.x)
    })

    it('stacks pipelines that do not depend on each other', () => {
      const result = split()
      const solo = band(result, 'mm_solo')
      const up = band(result, 'zz_up')
      expect(solo.x).toBe(up.x)
      expect(Math.abs(solo.y - up.y)).toBeGreaterThanOrEqual(Math.min(solo.height, up.height))
    })

    it('gives every pipeline its own stage lanes and group rows inside its box', () => {
      const result = split()
      expect(result.lanes.filter((l) => l.pipeline === 'aa_down').map((l) => l.stage)).toEqual(['src', 'int', 'out'])
      expect(result.rows.filter((r) => r.pipeline === 'aa_down').map((r) => r.group).sort()).toEqual(['claims', 'finance'])
      for (const box of [...result.lanes, ...result.rows]) {
        const b = band(result, box.pipeline!)
        expect(box.x).toBeGreaterThanOrEqual(b.x)
        expect(box.y).toBeGreaterThanOrEqual(b.y)
        expect(box.x + box.width).toBeLessThanOrEqual(b.x + b.width)
        expect(box.y + box.height).toBeLessThanOrEqual(b.y + b.height)
      }
    })

    it('draws no box around a single pipeline', () => {
      const { pipelines } = layoutGraph(grouped, groupedEdges, 'lanes')
      expect(pipelines).toEqual([])
    })
  })

  describe('configured layers', () => {
    const nodes = [
      node('m', 'marts'),
      node('s', 'staging'),
      node('i', 'intermediate'),
      node('x', 'other'),
      node('q', 'zz_unknown'),
    ]
    const edges = [edge('s', 'i'), edge('i', 'm')]

    it('lays the stage columns out in the configured order, unknown stages after, other last', () => {
      const { lanes, positions } = layoutGraph(nodes, edges, 'lanes', undefined, {
        zones: 'stages',
        stageOrder: ['staging', 'intermediate', 'marts'],
      })
      expect(lanes.map((l) => l.stage)).toEqual(['staging', 'intermediate', 'marts', 'zz_unknown', 'other'])
      expect(positions.get('s')!.x).toBeLessThan(positions.get('i')!.x)
      expect(positions.get('i')!.x).toBeLessThan(positions.get('m')!.x)
    })
  })
})
