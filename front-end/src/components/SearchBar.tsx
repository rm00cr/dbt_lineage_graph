/**
 * SearchBar (AP-3, features 1.5 + 2.2).
 *
 * Models  -> client-side fuzzy search with Fuse.js (instant, typo tolerant).
 * Columns -> server-side `/api/search/columns`, because column metadata is not part of
 *            the slim graph payload.
 */

import Fuse, { type FuseResult } from 'fuse.js'
import { Columns3, Loader2, Search, Table2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../api/client'
import type { GraphNode, SearchHit } from '../api/types'
import { useExplorerStore } from '../store/useExplorerStore'
import { STAGE_LABELS, useStageColor } from './visual'

type Mode = 'models' | 'columns'

interface Row {
  id: string
  name: string
  stage: GraphNode['stage']
  meta: string
  column?: string
  score: number
}

const MAX_ROWS = 12

export function SearchBar() {
  const graph = useExplorerStore((s) => s.graph)
  const usingMock = useExplorerStore((s) => s.usingMock)
  const openModel = useExplorerStore((s) => s.openModel)
  const select = useExplorerStore((s) => s.select)

  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>('models')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [columnHits, setColumnHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [columnError, setColumnError] = useState<string | null>(null)
  const stageColor = useStageColor()

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // ------------------------------------------------------------- fuse index
  const fuse = useMemo(
    () =>
      new Fuse(graph?.nodes ?? [], {
        keys: [
          { name: 'name', weight: 0.72 },
          { name: 'tags', weight: 0.14 },
          { name: 'description', weight: 0.08 },
          { name: 'schema_name', weight: 0.06 },
        ],
        includeScore: true,
        threshold: 0.42,
        ignoreLocation: true,
        minMatchCharLength: 2,
      }),
    [graph],
  )

  // ------------------------------------------------------------- column search
  useEffect(() => {
    if (mode !== 'columns' || query.trim().length < 2) {
      setColumnHits([])
      setColumnError(null)
      return
    }
    if (usingMock) {
      setColumnHits([])
      setColumnError('Column search needs the API (currently on mock data).')
      return
    }

    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.searchColumns(query.trim(), 40)
        if (!cancelled) {
          setColumnHits(response.results)
          setColumnError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setColumnHits([])
          setColumnError((error as Error).message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, mode, usingMock])

  // ------------------------------------------------------------- rows
  const rows = useMemo<Row[]>(() => {
    if (query.trim().length < 1) return []

    if (mode === 'models') {
      return fuse
        .search(query.trim(), { limit: MAX_ROWS })
        .map((hit: FuseResult<GraphNode>) => ({
          id: hit.item.id,
          name: hit.item.name,
          stage: hit.item.stage,
          meta: `${STAGE_LABELS[hit.item.stage]} · ${hit.item.materialization} · ${hit.item.pipeline}`,
          score: 1 - (hit.score ?? 0),
        }))
    }

    return columnHits.slice(0, MAX_ROWS).map((hit) => ({
      id: hit.id,
      name: hit.name,
      stage: hit.stage,
      meta: hit.column?.type ? `${hit.column.type} · ${hit.pipeline}` : hit.pipeline,
      column: hit.column?.name,
      score: hit.score,
    }))
  }, [query, mode, fuse, columnHits])

  useEffect(() => setCursor(0), [query, mode])

  // ------------------------------------------------------------- global shortcut
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      if ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key === 'k')) {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ------------------------------------------------------------- click outside
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [])

  const pick = (row: Row) => {
    select([row.id])
    void openModel(row.id)
    setOpen(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((c) => Math.min(c + 1, rows.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (event.key === 'Enter' && rows[cursor]) {
      pick(rows[cursor])
    } else if (event.key === 'Escape') {
      setOpen(false)
      event.currentTarget.blur()
    }
  }

  return (
    <div className="search" ref={containerRef}>
      <div className="search__field">
        <Search size={15} color="var(--text-faint)" />
        <input
          ref={inputRef}
          value={query}
          placeholder={mode === 'models' ? 'Search models (fuzzy)…' : 'Search columns…'}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />

        {loading && <Loader2 size={14} className="spin" color="var(--text-faint)" />}

        {query && (
          <button
            className="btn btn--ghost btn--icon btn--sm"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
            title="Clear"
          >
            <X size={13} />
          </button>
        )}

        <div className="search__mode">
          <button data-active={mode === 'models'} onClick={() => setMode('models')} title="Search model names">
            <Table2 size={11} /> Models
          </button>
          <button data-active={mode === 'columns'} onClick={() => setMode('columns')} title="Search column names">
            <Columns3 size={11} /> Columns
          </button>
        </div>

        <span className="search__kbd">/</span>
      </div>

      {open && (query.trim().length > 0 || columnError) && (
        <div className="search__results">
          {columnError && <div className="search__empty">{columnError}</div>}

          {!columnError && rows.length === 0 && !loading && (
            <div className="search__empty">No match for “{query}”</div>
          )}

          {rows.length > 0 && (
            <div className="search__hint">
              {mode === 'models' ? 'Models' : 'Columns'} · ↑↓ to navigate · ⏎ to open
            </div>
          )}

          {rows.map((row, index) => (
            <button
              key={`${row.id}:${row.column ?? ''}`}
              className="result"
              data-active={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => pick(row)}
            >
              <span className="result__dot" style={{ background: stageColor(row.stage), color: stageColor(row.stage) }} />
              <span className="result__main">
                <span className="result__name">
                  {row.column ? (
                    <>
                      <span className="result__col">{row.column}</span>
                      <span style={{ color: 'var(--text-faint)' }}> in </span>
                      {row.name}
                    </>
                  ) : (
                    row.name
                  )}
                </span>
                <span className="result__meta">{row.meta}</span>
              </span>
              <span className="result__score">{Math.round(row.score * 100)}%</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
