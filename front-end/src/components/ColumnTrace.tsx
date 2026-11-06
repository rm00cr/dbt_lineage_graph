/**
 * Column-level lineage UI (2.3):
 *   - TraceBar: floating bar on the canvas while a column is traced (direction, legend, close)
 *   - ColumnTracePanel: hop-by-hop list with the SQL expression of every edge, in the Schema tab
 */

import { ArrowDownRight, ArrowUpRight, Route, TriangleAlert, X } from 'lucide-react'
import { useMemo } from 'react'

import type { ColumnEdgeKind, ColumnLineageEdge, TraceDirection } from '../api/types'
import { EDGE_KIND_LABELS } from '../graph/columnTrace'
import { useExplorerStore } from '../store/useExplorerStore'

const DIRECTIONS: { value: TraceDirection; label: string; title: string }[] = [
  { value: 'up', label: 'Origins', title: 'where does this column come from?' },
  { value: 'both', label: 'Both', title: 'origins and impact' },
  { value: 'down', label: 'Impact', title: 'what depends on this column?' },
]

const KINDS: ColumnEdgeKind[] = ['passthrough', 'rename', 'transform', 'aggregate']

function useModelName() {
  const index = useExplorerStore((s) => s.index)
  return (id: string) => index.byId.get(id)?.name ?? id.split('.').slice(2).join('.')
}

function DirectionSwitch() {
  const direction = useExplorerStore((s) => s.columnTrace?.direction ?? 'both')
  const setDirection = useExplorerStore((s) => s.setTraceDirection)
  return (
    <div className="segmented" role="group" aria-label="Trace direction">
      {DIRECTIONS.map((option) => (
        <button
          key={option.value}
          data-active={direction === option.value}
          title={option.title}
          onClick={() => void setDirection(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function TraceBar() {
  const trace = useExplorerStore((s) => s.columnTrace)
  const clear = useExplorerStore((s) => s.clearColumnTrace)
  const withOverlay = useExplorerStore((s) => s.activeId !== null)
  const modelName = useModelName()
  if (!trace) return null

  const columnCount = trace.view ? [...trace.view.columnsByNode.values()].reduce((n, c) => n + c.length, 0) : 0

  return (
    <div className={`trace-bar${withOverlay ? ' trace-bar--with-overlay' : ''}`} role="status">
      <Route size={14} color="var(--accent)" />
      <span className="trace-bar__target" title={`${trace.modelId}.${trace.column}`}>
        {modelName(trace.modelId)}.<strong>{trace.column}</strong>
      </span>
      <span className="trace-bar__meta">
        {trace.loading
          ? 'tracing…'
          : trace.error
            ? trace.error
            : `${columnCount} columns · ${trace.view?.nodeIds.size ?? 0} models`}
      </span>
      {trace.warnings.length > 0 && (
        <span title={trace.warnings.join('\n')} style={{ color: 'var(--warn)', display: 'inline-flex' }}>
          <TriangleAlert size={14} />
        </span>
      )}
      <DirectionSwitch />
      <span className="trace-bar__meta trace-bar__legend">
        {KINDS.map((kind) => (
          <span key={kind} title={EDGE_KIND_LABELS[kind]} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className={`cedge-swatch cedge-swatch--${kind}`} />
            {EDGE_KIND_LABELS[kind]}
          </span>
        ))}
      </span>
      <button className="icon-button" onClick={clear} title="Stop tracing (Esc)" aria-label="Stop tracing">
        <X size={14} />
      </button>
    </div>
  )
}

export function ColumnTracePanel() {
  const trace = useExplorerStore((s) => s.columnTrace)
  const clear = useExplorerStore((s) => s.clearColumnTrace)
  const openModel = useExplorerStore((s) => s.openModel)
  const modelName = useModelName()

  const hops = useMemo(() => {
    if (!trace?.view) return { up: [] as ColumnLineageEdge[], down: [] as ColumnLineageEdge[] }
    const roles = trace.view.columnsByNode
    const roleOf = (model: string, column: string) => roles.get(model)?.find((c) => c.name === column)
    const up: ColumnLineageEdge[] = []
    const down: ColumnLineageEdge[] = []
    for (const edge of trace.view.edges) {
      const target = roleOf(edge.target_model, edge.target_column)
      const source = roleOf(edge.source_model, edge.source_column)
      if (target?.role === 'downstream' || source?.role === 'downstream') down.push(edge)
      else up.push(edge)
    }
    const distance = (edge: ColumnLineageEdge, side: 'source' | 'target') =>
      (side === 'source'
        ? roleOf(edge.source_model, edge.source_column)
        : roleOf(edge.target_model, edge.target_column)
      )?.distance ?? 0
    up.sort((a, b) => distance(a, 'source') - distance(b, 'source'))
    down.sort((a, b) => distance(a, 'target') - distance(b, 'target'))
    return { up, down }
  }, [trace])

  if (!trace) return null

  const ref = (model: string, column: string) => (
    <>
      <button onClick={() => void openModel(model, { tab: 'schema' })} title={model}>
        {modelName(model)}
      </button>
      .{column}
    </>
  )

  const section = (title: string, icon: React.ReactNode, edges: ColumnLineageEdge[], empty: string) => (
    <div style={{ marginTop: 8 }}>
      <div className="section__title">
        {icon} {title} <span className="tab__count">{edges.length}</span>
      </div>
      {edges.length === 0 ? (
        <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>{empty}</div>
      ) : (
        edges.map((edge) => (
          <div key={edge.id} className="trace-hop">
            <span className={`cedge-swatch cedge-swatch--${edge.kind}`} title={edge.kind} />
            <span className="trace-hop__path">
              {ref(edge.source_model, edge.source_column)} → {ref(edge.target_model, edge.target_column)}{' '}
              <span style={{ color: 'var(--text-faint)' }}>({edge.kind})</span>
            </span>
            {edge.expression && <code className="trace-hop__expr">{edge.expression}</code>}
          </div>
        ))
      )}
    </div>
  )

  return (
    <div className="trace-panel">
      <div className="trace-panel__head">
        <Route size={14} color="var(--accent)" />
        <span className="trace-panel__title">
          Column lineage: {modelName(trace.modelId)}.{trace.column}
        </span>
        <button className="icon-button" onClick={clear} title="Stop tracing" aria-label="Stop tracing">
          <X size={14} />
        </button>
      </div>
      <DirectionSwitch />

      {trace.loading && !trace.view && <div style={{ marginTop: 8 }}>Tracing…</div>}
      {trace.error && <div className="trace-warning">Could not trace this column: {trace.error}</div>}
      {trace.warnings.map((warning) => (
        <div key={warning} className="trace-warning">
          <TriangleAlert size={12} /> {warning}
        </div>
      ))}

      {trace.view && (
        <>
          {trace.direction !== 'down' &&
            section('Origins', <ArrowUpRight size={12} />, hops.up, 'No upstream columns: constant or a root source.')}
          {trace.direction !== 'up' &&
            section('Impact', <ArrowDownRight size={12} />, hops.down, 'Nothing downstream uses this column.')}
        </>
      )}
    </div>
  )
}
