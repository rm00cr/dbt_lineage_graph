import { describe, expect, it } from 'vitest'

import type { ColumnLineageEdge, ColumnLineageResponse, ColumnNode } from '../api/types'
import {
  MAX_TRACE_ROWS,
  buildTraceView,
  crossesPipeline,
  decodeTraceParam,
  edgeHandles,
  encodeTraceParam,
  pipelineRoute,
  rowHandleId,
  traceNodeHeight,
} from './columnTrace'

/**
 *  raw.amount ─> stg.amount ─> fct.total (aggregate)
 *                          └─> rpt.amount
 *  trace root: stg.amount
 */
const col = (model: string, column: string, distance: number): ColumnNode => ({
  model_id: model,
  model_name: model,
  column,
  type: null,
  distance,
})
const edge = (s: string, sc: string, t: string, tc: string, kind: ColumnLineageEdge['kind'] = 'passthrough') => ({
  id: `${s}.${sc}->${t}.${tc}`,
  source_model: s,
  source_column: sc,
  target_model: t,
  target_column: tc,
  kind,
  expression: null,
})

const TRACE: ColumnLineageResponse = {
  root: col('stg', 'amount', 0),
  direction: 'both',
  depth: null,
  nodes: [col('stg', 'amount', 0), col('raw', 'amount', 1), col('fct', 'total', 1), col('rpt', 'amount', 1)],
  edges: [
    edge('raw', 'amount', 'stg', 'amount'),
    edge('stg', 'amount', 'fct', 'total', 'aggregate'),
    edge('stg', 'amount', 'rpt', 'amount'),
  ],
  warnings: [],
}

describe('buildTraceView', () => {
  it('collects nodes, model edges and roles', () => {
    const view = buildTraceView(TRACE)
    expect([...view.nodeIds].sort()).toEqual(['fct', 'raw', 'rpt', 'stg'])
    expect([...view.modelEdgeIds].sort()).toEqual(['raw->stg', 'stg->fct', 'stg->rpt'])
    expect(view.columnsByNode.get('stg')).toEqual([{ name: 'amount', role: 'root', distance: 0 }])
    expect(view.columnsByNode.get('raw')?.[0].role).toBe('upstream')
    expect(view.columnsByNode.get('fct')?.[0]).toEqual({ name: 'total', role: 'downstream', distance: 1 })
  })

  it('puts the root column first inside its node', () => {
    const view = buildTraceView({
      ...TRACE,
      nodes: [...TRACE.nodes, col('stg', 'aaa_other', 2)],
    })
    expect(view.columnsByNode.get('stg')?.map((c) => c.name)).toEqual(['amount', 'aaa_other'])
  })
})

describe('row handles', () => {
  it('uses a row handle only for visible columns', () => {
    const many = Array.from({ length: MAX_TRACE_ROWS + 2 }, (_, i) => col('wide', `c${String(i).padStart(2, '0')}`, 1))
    const trace: ColumnLineageResponse = {
      ...TRACE,
      nodes: [...TRACE.nodes, ...many],
      edges: [...TRACE.edges, edge('wide', 'c00', 'stg', 'amount'), edge('wide', 'c09', 'stg', 'amount')],
    }
    const view = buildTraceView(trace)
    expect(edgeHandles(view, trace.edges[3])).toEqual({
      sourceHandle: rowHandleId('c00', 'out'),
      targetHandle: rowHandleId('amount', 'in'),
    })
    expect(edgeHandles(view, trace.edges[4]).sourceHandle).toBeUndefined()
  })

  it('grows the node height with its rows and caps it', () => {
    expect(traceNodeHeight(96, undefined)).toBe(96)
    const one = traceNodeHeight(96, [{ name: 'a', role: 'root', distance: 0 }])
    expect(one).toBeGreaterThan(96)
    const capped = Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, role: 'upstream' as const, distance: 1 }))
    const nine = Array.from({ length: MAX_TRACE_ROWS + 1 }, (_, i) => ({ name: `c${i}`, role: 'upstream' as const, distance: 1 }))
    expect(traceNodeHeight(96, capped)).toBe(traceNodeHeight(96, nine))
  })
})

describe('URL param', () => {
  it('round-trips ids that contain dots and pipes in the model part', () => {
    const encoded = encodeTraceParam('model.p.a|b', 'amount')
    expect(decodeTraceParam(encoded)).toEqual({ modelId: 'model.p.a|b', column: 'amount' })
    expect(decodeTraceParam('broken')).toBeNull()
    expect(decodeTraceParam('model|')).toBeNull()
    expect(decodeTraceParam(null)).toBeNull()
  })
})

describe('pipelines of a trace', () => {
  /**
   *  bestand: raw.amount ─> stg.amount (root)
   *  claims:  imported stg ─> fct.total
   *  finance: rpt.amount (downstream of stg, two hops away through claims' import)
   */
  const PIPELINE: Record<string, string> = { raw: 'bestand', stg: 'bestand', fct: 'claims', rpt: 'finance' }
  const pipelineOf = (id: string) => PIPELINE[id] ?? ''

  it('flags edges that enter another pipeline', () => {
    const [rawToStg, stgToFct, stgToRpt] = TRACE.edges
    expect(crossesPipeline(rawToStg, pipelineOf)).toBe(false)
    expect(crossesPipeline(stgToFct, pipelineOf)).toBe(true)
    expect(crossesPipeline(stgToRpt, pipelineOf)).toBe(true)
  })

  it('orders the route from origins to impact', () => {
    const view = buildTraceView({ ...TRACE, nodes: [...TRACE.nodes.slice(0, 3), col('rpt', 'amount', 2)] })
    expect(pipelineRoute(view, pipelineOf)).toEqual(['bestand', 'claims', 'finance'])
  })

  it('places a pipeline by its furthest-upstream column', () => {
    // claims holds an origin (distance 2 upstream) and an impact column: it comes first
    const view = buildTraceView({
      ...TRACE,
      nodes: [...TRACE.nodes, col('origin', 'amount', 2)],
      edges: [...TRACE.edges, edge('origin', 'amount', 'raw', 'amount')],
    })
    expect(pipelineRoute(view, (id) => ({ ...PIPELINE, origin: 'claims' })[id] ?? '')).toEqual([
      'claims',
      'bestand',
      'finance',
    ])
  })

  it('is a single pipeline when the trace stays inside one', () => {
    expect(pipelineRoute(buildTraceView(TRACE), () => 'only')).toEqual(['only'])
  })
})
