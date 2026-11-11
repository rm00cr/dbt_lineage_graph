/**
 * State comparison UI: compare the running lineage with another state of the project
 * (the manifest.json + catalog.json of a development branch).
 *
 *   - CompareButton: top-bar entry point
 *   - CompareDialog: upload the two artifacts
 *   - CompareBar:    floating summary while comparing (counts, select changes, exit)
 *   - ChangesPanel:  "Changes" tab of the overlay: what changed on one node
 */

import {
  ArrowUpRight,
  FileJson,
  GitCompare,
  ListChecks,
  Loader2,
  SlidersHorizontal,
  Table2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import { useId, useState } from 'react'

import type { ChangeStatus, NodeChange, NodeRef } from '../api/types'
import { CHANGE_LABELS, CHANGE_SYMBOLS, type DiffLine, parseUnifiedDiff } from '../graph/diff'
import { useExplorerStore } from '../store/useExplorerStore'
import { usePanelPrefs } from '../store/usePanelPrefs'
import { WrapToggle } from './CodeViewer'
import { formatBytes } from './visual'

// --------------------------------------------------------------------------- entry point

export function CompareButton() {
  const comparing = useExplorerStore((s) => s.compare !== null)
  const open = useExplorerStore((s) => s.setCompareDialogOpen)
  return (
    <button
      type="button"
      data-tour="compare"
      className={`btn btn--sm${comparing ? ' btn--active' : ''}`}
      onClick={() => open(true)}
      title="Compare the running state with another manifest.json / catalog.json"
    >
      <GitCompare size={14} /> Compare
    </button>
  )
}

// --------------------------------------------------------------------------- dialog

/** dropping both files at once: tell them apart by name, then by content */
function sortDroppedFiles(files: File[]): { manifest?: File; catalog?: File } {
  const json = files.filter((f) => f.name.toLowerCase().endsWith('.json'))
  const catalog = json.find((f) => /catalog/i.test(f.name))
  const manifest = json.find((f) => f !== catalog && /manifest/i.test(f.name)) ?? json.find((f) => f !== catalog)
  return { manifest, catalog }
}

function FileDrop({
  label,
  hint,
  file,
  onFile,
  onFiles,
}: {
  label: string
  hint: string
  file: File | null
  onFile: (file: File | null) => void
  onFiles: (files: File[]) => void
}) {
  const id = useId()
  const [over, setOver] = useState(false)
  return (
    <label
      htmlFor={id}
      className="file-drop"
      data-over={over}
      data-filled={file !== null}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const files = [...event.dataTransfer.files]
        if (files.length > 1) onFiles(files)
        else onFile(files[0] ?? null)
      }}
    >
      <input
        id={id}
        type="file"
        accept=".json,application/json"
        onChange={(event) => onFile(event.target.files?.[0] ?? null)}
      />
      <span className="file-drop__icon">{file ? <FileJson size={18} /> : <Upload size={18} />}</span>
      <span className="file-drop__text">
        <span className="file-drop__label">{label}</span>
        <span className="file-drop__hint">
          {file ? `${file.name} · ${formatBytes(file.size)}` : hint}
        </span>
      </span>
      {file && (
        <button
          type="button"
          className="icon-button"
          aria-label={`Remove ${label}`}
          onClick={(event) => {
            event.preventDefault()
            onFile(null)
          }}
        >
          <X size={14} />
        </button>
      )}
    </label>
  )
}

/** stable fallback: a fresh `[]` from a store selector re-renders forever */
const NO_PIPELINES: string[] = []

export function CompareDialog() {
  const open = useExplorerStore((s) => s.compareDialogOpen)
  const setOpen = useExplorerStore((s) => s.setCompareDialogOpen)
  const loading = useExplorerStore((s) => s.compareLoading)
  const error = useExplorerStore((s) => s.compareError)
  const startCompare = useExplorerStore((s) => s.startCompare)
  const pipelines = useExplorerStore((s) => s.meta?.pipelines ?? NO_PIPELINES)
  const filtered = useExplorerStore((s) => s.filters.pipelines)

  const [manifest, setManifest] = useState<File | null>(null)
  const [catalog, setCatalog] = useState<File | null>(null)
  const [label, setLabel] = useState('')
  // which running pipeline the upload replaces: all projects share one dbt project name
  const [pipelineChoice, setPipelineChoice] = useState<string | null>(null)
  const pipeline =
    pipelineChoice ?? (filtered.length === 1 && pipelines.includes(filtered[0]) ? filtered[0] : pipelines[0] ?? '')

  if (!open) return null

  const takeBoth = (files: File[]) => {
    const sorted = sortDroppedFiles(files)
    if (sorted.manifest) setManifest(sorted.manifest)
    if (sorted.catalog) setCatalog(sorted.catalog)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!manifest || loading) return
    const ok = await startCompare(manifest, catalog, label.trim() || undefined, pipeline || undefined)
    if (ok) {
      setManifest(null)
      setCatalog(null)
      setLabel('')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setOpen(false)
          }
        }}
      >
        <div className="modal__head">
          <GitCompare size={16} color="var(--accent)" />
          <h2 id="compare-title" className="modal__title">
            Compare with another state
          </h2>
          <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <p className="modal__text">
          Upload the dbt artifacts of one pipeline in a development state, e.g. after{' '}
          <code>dbt docs generate</code> on your branch. They replace the pipeline you choose, the other
          pipelines stay as they are. The graph then shows what changes{' '}
          <span className="diff-word diff-word--added">add</span>,{' '}
          <span className="diff-word diff-word--modified">modify</span> and{' '}
          <span className="diff-word diff-word--removed">remove</span>.
        </p>

        <FileDrop
          label="manifest.json"
          hint="required · drop it here or click to choose"
          file={manifest}
          onFile={setManifest}
          onFiles={takeBoth}
        />
        <FileDrop
          label="catalog.json"
          hint="optional · without it column changes are not compared"
          file={catalog}
          onFile={setCatalog}
          onFiles={takeBoth}
        />

        {pipelines.length > 0 && (
          <label className="modal__field">
            <span>Pipeline it replaces</span>
            <select className="input" value={pipeline} onChange={(event) => setPipelineChoice(event.target.value)}>
              {pipelines.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="modal__field">
          <span>Name of this state</span>
          <input
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={manifest ? manifest.name : 'e.g. feature/churn-risk'}
          />
        </label>

        <p className="modal__note">
          Code is compared on the SQL you wrote (<code>raw_code</code>), so a dev target with other schemas
          does not make every model look modified.
        </p>

        {error && (
          <div className="modal__error" role="alert">
            <TriangleAlert size={14} /> {error}
          </div>
        )}

        <div className="modal__actions">
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn--sm btn--primary" disabled={!manifest || loading}>
            {loading ? <Loader2 size={13} className="spin" /> : <GitCompare size={13} />}
            {loading ? 'Comparing…' : 'Compare'}
          </button>
        </div>
      </form>
    </div>
  )
}

// --------------------------------------------------------------------------- bar

const SUMMARY_ORDER: Exclude<ChangeStatus, 'unchanged'>[] = ['added', 'modified', 'removed']

export function CompareBar({ onToast }: { onToast: (message: string) => void }) {
  const compare = useExplorerStore((s) => s.compare)
  const exitCompare = useExplorerStore((s) => s.exitCompare)
  const selectChanges = useExplorerStore((s) => s.selectChanges)
  if (!compare) return null

  const { summary, warnings, head, pipeline } = compare.response
  const total = summary.added + summary.modified + summary.removed

  return (
    <div className="compare-bar" role="status">
      <GitCompare size={14} color="var(--accent)" />
      <span className="compare-bar__states" title={`running state ↔ ${head.label} (pipeline ${pipeline})`}>
        running ↔ <strong>{head.label}</strong>
        <span className="compare-bar__pipeline"> · {pipeline}</span>
      </span>
      {SUMMARY_ORDER.map((status) => (
        <span key={status} className="diff-chip" data-change={status} title={`${summary[status]} ${CHANGE_LABELS[status]}`}>
          {CHANGE_SYMBOLS[status]}
          {summary[status]} {CHANGE_LABELS[status]}
        </span>
      ))}
      <span className="compare-bar__meta">{summary.unchanged} unchanged</span>
      {warnings.length > 0 && (
        <span className="compare-bar__warn" title={warnings.join('\n')}>
          <TriangleAlert size={14} />
        </span>
      )}
      <button
        type="button"
        className="btn btn--sm"
        disabled={total === 0}
        onClick={() => {
          selectChanges()
          onToast(`${total} changed models selected, with their lineage`)
        }}
        title="Select every changed model; focus mode then shows what they affect"
      >
        <ListChecks size={13} /> Select changes
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={() => void exitCompare()}
        title="Stop comparing, back to the running state"
        aria-label="Stop comparing"
      >
        <X size={14} />
      </button>
    </div>
  )
}

// --------------------------------------------------------------------------- overlay tab

const FIELD_LABELS: Record<string, string> = {
  materialization: 'Materialization',
  alias: 'Alias',
  group: 'Group',
  pipeline: 'Pipeline',
  stage: 'Stage',
  tags: 'Tags',
  execution_mode: 'Execution mode',
  description: 'Description',
  database: 'Database',
  schema: 'Schema',
}

export function ChangesPanel({ change, onPick }: { change: NodeChange; onPick: (id: string) => void }) {
  const compare = useExplorerStore((s) => s.compare)
  const headLabel = compare?.response.head.label ?? 'the uploaded state'
  const columnsCompared = compare?.response.columns_compared ?? false

  if (change.status === 'added') {
    return (
      <div className="section">
        <div className="change-callout" data-change="added">
          New in <strong>{headLabel}</strong>. The Code and Schema tabs show its uploaded version.
        </div>
      </div>
    )
  }
  if (change.status === 'removed') {
    return (
      <div className="section">
        <div className="change-callout" data-change="removed">
          No longer in <strong>{headLabel}</strong>. The other tabs show the running version.
        </div>
      </div>
    )
  }

  const nothingListed =
    change.fields.length === 0 &&
    change.columns.length === 0 &&
    !change.code_changed &&
    change.upstream_added.length === 0 &&
    change.upstream_removed.length === 0

  return (
    <>
      <div className="section">
        <div className="change-callout" data-change="modified">
          Modified in <strong>{headLabel}</strong>. The other tabs show the uploaded version.
        </div>
      </div>

      {change.fields.length > 0 && (
        <div className="section">
          <div className="section__title">
            <SlidersHorizontal size={12} /> Properties <span className="tab__count">{change.fields.length}</span>
          </div>
          <table className="table change-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Running</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {change.fields.map((field) => (
                <tr key={field.field}>
                  <td>{FIELD_LABELS[field.field] ?? field.field}</td>
                  <td className="change-table__old">{field.base ?? '–'}</td>
                  <td className="change-table__new">{field.head ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(change.upstream_added.length > 0 || change.upstream_removed.length > 0) && (
        <div className="section">
          <div className="section__title">
            <ArrowUpRight size={12} /> Upstream dependencies
          </div>
          <div className="dep-list">
            {change.upstream_added.map((ref) => (
              <ChangedRef key={ref.id} node={ref} status="added" onPick={onPick} />
            ))}
            {change.upstream_removed.map((ref) => (
              <ChangedRef key={ref.id} node={ref} status="removed" onPick={onPick} />
            ))}
          </div>
        </div>
      )}

      {change.columns.length > 0 && (
        <div className="section">
          <div className="section__title">
            <Table2 size={12} /> Columns <span className="tab__count">{change.columns.length}</span>
          </div>
          <div className="change-columns">
            {change.columns.map((column) => {
              const status = column.change === 'type_changed' ? 'modified' : column.change
              return (
                <div key={column.name} className="change-column" data-change={status}>
                  <span className="change-column__symbol">{CHANGE_SYMBOLS[status]}</span>
                  <span className="change-column__name">{column.name}</span>
                  <span className="change-column__type">
                    {column.change === 'type_changed'
                      ? `${column.base_type} → ${column.head_type}`
                      : (column.head_type ?? column.base_type ?? '')}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {!columnsCompared && (
        <div className="section">
          <div className="empty">Columns were not compared: a catalog.json is missing on one side.</div>
        </div>
      )}

      {change.code_changed && (
        <div className="section">
          <div className="section__title">
            <FileJson size={12} /> SQL changes <span className="tab__count">raw_code</span>
            <span style={{ flex: 1 }} />
            <WrapToggle />
          </div>
          <CodeDiff diff={change.code_diff} />
        </div>
      )}

      {nothingListed && <div className="empty">Changed, but nothing that is shown here.</div>}
    </>
  )
}

function ChangedRef({ node, status, onPick }: { node: NodeRef; status: 'added' | 'removed'; onPick: (id: string) => void }) {
  return (
    <button className="dep" data-change={status} onClick={() => onPick(node.id)} title={node.id}>
      <span className="change-column__symbol">{CHANGE_SYMBOLS[status]}</span>
      <span className="dep__name">{node.name}</span>
      <span className="dep__badge">{status === 'added' ? 'new dependency' : 'dependency dropped'}</span>
    </button>
  )
}

export function CodeDiff({ diff }: { diff: string | null }) {
  const lines = parseUnifiedDiff(diff).filter((line) => line.kind !== 'file')
  if (lines.length === 0) return <div className="empty">Only whitespace changed.</div>
  return <DiffLines lines={lines} />
}

/** Numbered, coloured diff lines (shared by the comparison and the stacked modes). */
export function DiffLines({ lines, label = 'SQL diff' }: { lines: DiffLine[]; label?: string }) {
  const wrap = usePanelPrefs((s) => s.wrap)
  return (
    <div className={`code-diff${wrap ? ' code-diff--wrap' : ''}`} role="table" aria-label={label}>
      {lines.map((line, index) => (
        <div key={index} className="code-diff__line" data-kind={line.kind} role="row">
          <span className="code-diff__no">{line.oldNo ?? ''}</span>
          <span className="code-diff__no">{line.newNo ?? ''}</span>
          <span className="code-diff__sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
          <span className="code-diff__text">{line.text}</span>
        </div>
      ))}
    </div>
  )
}
