/**
 * SchemaTable (AP-3, feature 2.1): columns + data types + descriptions from catalog.json,
 * with an inline filter so wide tables stay usable. Each column can be traced (2.3).
 */

import { Route, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { ColumnInfo } from '../api/types'
import { useExplorerStore } from '../store/useExplorerStore'
import { ColumnTracePanel } from './ColumnTrace'

interface SchemaTableProps {
  columns: ColumnInfo[]
  /** the model the columns belong to; enables the column-lineage trace */
  modelId?: string
}

function TraceButton({ modelId, column }: { modelId: string; column: ColumnInfo }) {
  const traceColumn = useExplorerStore((s) => s.traceColumn)
  const up = column.upstream_count
  const down = column.downstream_count
  const unknown = up === null || up === undefined || down === null || down === undefined
  const isolated = !unknown && up === 0 && down === 0
  return (
    <button
      className="trace-btn"
      disabled={unknown || isolated}
      title={
        unknown
          ? 'Column lineage unavailable: the SQL of this model could not be parsed'
          : isolated
            ? 'No column lineage: constant or unused column'
            : `Trace ${column.name}: ${up} upstream, ${down} downstream`
      }
      onClick={() => void traceColumn(modelId, column.name)}
    >
      <Route size={11} />
      {unknown ? '–' : `↑${up} ↓${down}`}
    </button>
  )
}

function highlight(text: string, needle: string) {
  if (!needle) return text
  const index = text.toLowerCase().indexOf(needle.toLowerCase())
  if (index < 0) return text
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  )
}

export function SchemaTable({ columns, modelId }: SchemaTableProps) {
  const [filter, setFilter] = useState('')
  const trace = useExplorerStore((s) => s.columnTrace)

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return columns
    return columns.filter(
      (column) =>
        column.name.toLowerCase().includes(needle) ||
        (column.type ?? '').toLowerCase().includes(needle) ||
        (column.description ?? '').toLowerCase().includes(needle),
    )
  }, [columns, filter])

  if (columns.length === 0) {
    return (
      <div className="empty">
        No columns in <code>catalog.json</code> for this node. Run <code>dbt docs generate</code>, or
        the model is ephemeral.
      </div>
    )
  }

  return (
    <>
      <ColumnTracePanel />

      <div className="schema-search">
        <Search size={13} color="var(--text-faint)" />
        <input
          value={filter}
          placeholder={`Filter ${columns.length} columns…`}
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
        {filter && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {visible.length}/{columns.length}
          </span>
        )}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 28 }}>#</th>
            <th>Column</th>
            <th>Type</th>
            <th>Description</th>
            {modelId && <th style={{ width: 70 }}>Lineage</th>}
          </tr>
        </thead>
        <tbody>
          {visible.map((column) => (
            <tr
              key={column.name}
              data-traced={trace?.modelId === modelId && trace?.column.toLowerCase() === column.name.toLowerCase()}
            >
              <td style={{ color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
                {column.index ?? '–'}
              </td>
              <td className="table__name">{highlight(column.name, filter)}</td>
              <td className="table__type">{column.type ?? '–'}</td>
              <td className="table__desc">{column.description ?? '–'}</td>
              {modelId && (
                <td>
                  <TraceButton modelId={modelId} column={column} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {visible.length === 0 && <div className="empty">No column matches “{filter}”.</div>}
    </>
  )
}
