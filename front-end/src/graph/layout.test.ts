import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode, Stage } from '../api/types'
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph } from './layout'

const node = (id: string, stage: Stage, group: string | null = null): GraphNode => ({
  id,
  name: id,
  stage,
  materialization: 'table',
  pipeline: 'p',
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
    const { lanes, rows } = layoutGraph(grouped, groupedEdges, 'lanes', undefined, 'stages')
    expect(lanes.map((l) => l.stage)).toEqual(['src', 'out'])
    expect(rows).toEqual([])
  })

  it("'groups' draws group rows without stage lanes, columns by DAG depth", () => {
    const { positions, lanes, rows } = layoutGraph(grouped, groupedEdges, 'lanes', undefined, 'groups')
    expect(lanes).toEqual([])
    expect(new Set(rows.map((r) => r.group))).toEqual(new Set(['claims', 'contract']))
    expect(positions.get('a_out')!.x).toBeGreaterThan(positions.get('a_src')!.x)
    expect(positions.get('a_src')!.y).not.toBe(positions.get('b_src')!.y)
  })
})
