/**
 * SchemaTable (AP-3, feature 2.1): columns + data types + descriptions from catalog.json,
 * with an inline filter so wide tables stay usable.
 */

import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { ColumnInfo } from '../api/types'

interface SchemaTableProps {
  columns: ColumnInfo[]
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

export function SchemaTable({ columns }: SchemaTableProps) {
  const [filter, setFilter] = useState('')

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
          </tr>
        </thead>
        <tbody>
          {visible.map((column) => (
            <tr key={column.name}>
              <td style={{ color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
                {column.index ?? '–'}
              </td>
              <td className="table__name">{highlight(column.name, filter)}</td>
              <td className="table__type">{column.type ?? '–'}</td>
              <td className="table__desc">{column.description ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {visible.length === 0 && <div className="empty">No column matches “{filter}”.</div>}
    </>
  )
}
