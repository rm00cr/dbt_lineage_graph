import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode, Stage } from '../api/types'
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph, orderPipelines } from './layout'

const node = (
  id: string,
  stage: Stage,
  group: string | null = null,
  pipeline = 'p',
  folder: string | null = null,
): GraphNode => ({
  id,
  name: id,
  stage,
  materialization: 'table',
  pipeline,
  resource_type: 'model',
  group,
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

  describe('split by pipeline', () => {
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
    const split = () => layoutGraph(multi, multiEdges, 'lanes', undefined, { zones: 'both', splitPipelines: true })
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

    it('is a no-op with a single pipeline', () => {
      const { pipelines } = layoutGraph(grouped, groupedEdges, 'lanes', undefined, { splitPipelines: true })
      expect(pipelines).toEqual([])
    })
  })
})

describe("folders layout (stage boxes with one box per model sub-folder)", () => {
  const nodes = [
    node('c_src', 'src', null, 'p', 'claim'),
    node('k_src', 'src', null, 'p', 'contract'),
    node('c_int', 'int', null, 'p', 'claim'),
    node('j_int', 'int', null, 'p', 'contract_with_claim'),
    node('j2_int', 'int', null, 'p', 'contract_with_claim'),
    node('r_int', 'int', null, 'p', null), // directly in 02_intermediate
    node('out', 'out', null, 'p', null),
  ]
  const edges = [edge('c_src', 'c_int'), edge('k_src', 'j_int'), edge('c_int', 'j_int'), edge('j_int', 'j2_int'), edge('j2_int', 'out')]
  const run = () => layoutGraph(nodes, edges, 'lanes', undefined, { zones: 'folders' })
  const boxOf = (result: ReturnType<typeof run>, stage: Stage, folder: string | null) =>
    result.folders.find((f) => f.stage === stage && f.folder === folder)!

  it('draws one stage lane per stage and one folder box per (stage, folder)', () => {
    const { lanes, folders, rows } = run()
    expect(lanes.map((l) => l.stage)).toEqual(['src', 'int', 'out'])
    expect(rows).toEqual([]) // no dbt-group rows in this mode
    expect(folders.map((f) => `${f.stage}/${f.folder ?? '(root)'}`).sort()).toEqual(
      ['int/(root)', 'int/claim', 'int/contract_with_claim', 'out/(root)', 'src/claim', 'src/contract'].sort(),
    )
  })

  it('puts every node inside the folder box of its own stage and folder', () => {
    const result = run()
    for (const n of nodes) {
      const p = result.positions.get(n.id)!
      const box = boxOf(result, n.stage, n.folder ?? null)
      expect(p.x).toBeGreaterThanOrEqual(box.x)
      expect(p.y).toBeGreaterThanOrEqual(box.y)
      expect(p.x + NODE_WIDTH).toBeLessThanOrEqual(box.x + box.width)
      expect(p.y + NODE_HEIGHT).toBeLessThanOrEqual(box.y + box.height)
    }
  })

  it('keeps folder boxes of a stage apart, and inside their stage lane', () => {
    const result = run()
    for (const lane of result.lanes) {
      const inStage = result.folders.filter((f) => f.stage === lane.stage)
      for (const f of inStage) {
        expect(f.x).toBeGreaterThanOrEqual(lane.x)
        expect(f.x + f.width).toBeLessThanOrEqual(lane.x + lane.width)
        expect(f.y + f.height).toBeLessThanOrEqual(lane.y + lane.height)
      }
      const sorted = [...inStage].sort((a, b) => a.y - b.y)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].height)
      }
    }
  })

  it('aligns sub-columns across folders of the same stage, and orders stages left to right', () => {
    const result = run()
    // int: depth-0 nodes of different folders ('claim', root) share a sub-column x
    expect(result.positions.get('c_int')!.x).toBe(result.positions.get('r_int')!.x)
    // a node one hop deeper inside the stage moves right, in every folder alike
    expect(result.positions.get('j_int')!.x).toBeGreaterThan(result.positions.get('c_int')!.x)
    expect(result.positions.get('j2_int')!.x).toBeGreaterThan(result.positions.get('j_int')!.x)
    const lane = (stage: Stage) => result.lanes.find((l) => l.stage === stage)!
    expect(lane('int').x).toBeGreaterThan(lane('src').x + lane('src').width - 1)
    expect(lane('out').x).toBeGreaterThan(lane('int').x)
  })

  it('draws no box for sources without a folder: they sit in the stage above the folder boxes', () => {
    const withSources = [
      node('raw1', 'src', null, 'p', null),
      node('raw2', 'src', null, 'p', null),
      { ...node('s1', 'src', null, 'p', 'claim') },
    ]
    withSources[0].resource_type = 'source'
    withSources[1].resource_type = 'source'
    const result = layoutGraph(withSources, [edge('raw1', 's1'), edge('raw2', 's1')], 'lanes', undefined, { zones: 'folders' })
    expect(result.folders.map((f) => f.folder)).toEqual(['claim']) // no source box
    const folderTop = result.folders[0].y
    expect(result.positions.get('raw1')!.y).toBeLessThan(folderTop)
    expect(result.positions.get('raw2')!.y).toBeLessThan(folderTop)
    const lane = result.lanes[0]
    expect(result.positions.get('raw1')!.x).toBeGreaterThanOrEqual(lane.x)
  })

  it('puts a source with a folder inside that folder box, next to its consumers', () => {
    const src = [
      { ...node('raw', 'src', null, 'p', 'claim'), resource_type: 'source' as const },
      node('m_src', 'src', null, 'p', 'claim'),
      node('o_src', 'src', null, 'p', 'adam'),
    ]
    const result = layoutGraph(src, [edge('raw', 'm_src')], 'lanes', undefined, { zones: 'folders' })
    const box = result.folders.find((f) => f.stage === 'src' && f.folder === 'claim')!
    const raw = result.positions.get('raw')!
    expect(raw.x).toBeGreaterThanOrEqual(box.x)
    expect(raw.y).toBeGreaterThanOrEqual(box.y)
    expect(raw.y + NODE_HEIGHT).toBeLessThanOrEqual(box.y + box.height)
    expect(result.folders.filter((f) => f.stage === 'src').map((f) => f.folder).sort()).toEqual(['adam', 'claim'])
  })

  it('lists the (root) folder last inside its stage', () => {
    const result = run()
    const ints = result.folders.filter((f) => f.stage === 'int').sort((a, b) => a.y - b.y)
    expect(ints.at(-1)!.folder).toBeNull()
  })

  it("'folders' ignores dbt groups even when they are set", () => {
    const grouped = nodes.map((n, i) => ({ ...n, group: i % 2 ? 'finance' : 'claims' }))
    const { rows, folders } = layoutGraph(grouped, edges, 'lanes', undefined, { zones: 'folders' })
    expect(rows).toEqual([])
    expect(folders.length).toBeGreaterThan(0)
  })

  it('places folder boxes inside each pipeline band when split by pipeline', () => {
    const multi = [
      node('a_src', 'src', null, 'aa', 'claim'),
      node('a_out', 'out', null, 'aa', null),
      node('b_src', 'src', null, 'bb', 'contract'),
      node('b_out', 'out', null, 'bb', null),
    ]
    const result = layoutGraph(multi, [edge('a_src', 'a_out'), edge('b_src', 'b_out')], 'lanes', undefined, {
      zones: 'folders',
      splitPipelines: true,
    })
    for (const f of result.folders) {
      const band = result.pipelines.find((b) => b.pipeline === f.pipeline)!
      expect(f.x).toBeGreaterThanOrEqual(band.x)
      expect(f.x + f.width).toBeLessThanOrEqual(band.x + band.width)
      expect(f.y + f.height).toBeLessThanOrEqual(band.y + band.height)
    }
  })
})

