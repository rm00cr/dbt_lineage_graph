/**
 * ModelOverlay (AP-3): sliding side panel with the model detail —
 * compiled code (1.2), dependencies/dependents (1.3), schema (2.1),
 * BigQuery deeplink (3.1) and the dbt run command (3.6).
 */

import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Code2,
  Database,
  ExternalLink,
  FileCode2,
  GitBranch,
  Info,
  Layers,
  Play,
  Table2,
  X,
} from 'lucide-react'
import { useState } from 'react'

import type { ModelDetail, NodeRef } from '../api/types'
import { type OverlayTab, useExplorerStore } from '../store/useExplorerStore'
import { CodeViewer } from './CodeViewer'
import { SchemaTable } from './SchemaTable'
import {
  MATERIALIZATION_ICONS,
  STAGE_LABELS,
  copyToClipboard,
  formatBytes,
  formatCount,
  stageColor,
} from './visual'

interface ModelOverlayProps {
  onToast: (message: string) => void
}

export function ModelOverlay({ onToast }: ModelOverlayProps) {
  const activeId = useExplorerStore((s) => s.activeId)
  const detail = useExplorerStore((s) => s.detail)
  const loading = useExplorerStore((s) => s.detailLoading)
  const error = useExplorerStore((s) => s.detailError)
  const closeOverlay = useExplorerStore((s) => s.closeOverlay)
  const openModel = useExplorerStore((s) => s.openModel)
  const select = useExplorerStore((s) => s.select)
  const expandSelectionLineage = useExplorerStore((s) => s.expandSelectionLineage)

  const tab = useExplorerStore((s) => s.overlayTab)
  const setTab = useExplorerStore((s) => s.setOverlayTab)
  const [copied, setCopied] = useState(false)

  if (!activeId) return null

  const color = stageColor(detail?.stage ?? 'other')

  const copyRunCommand = async () => {
    if (!detail?.dbt_run_command) return
    const ok = await copyToClipboard(detail.dbt_run_command)
    setCopied(ok)
    onToast(ok ? 'dbt run command copied' : 'Copy failed')
    window.setTimeout(() => setCopied(false), 1400)
  }

  const focusLineage = () => {
    select([activeId])
    expandSelectionLineage()
    onToast('Lineage selected')
  }

  return (
    <aside className="overlay" style={{ ['--stage-color' as string]: color }}>
      <header className="overlay__head">
        <div className="overlay__eyebrow">
          <span className="node__badge node__badge--stage" style={{ ['--stage-color' as string]: color }}>
            {STAGE_LABELS[detail?.stage ?? 'other']}
          </span>
          {detail && (
            <span className="node__badge">
              {(() => {
                const Icon = MATERIALIZATION_ICONS[detail.materialization]
                return <Icon size={10} strokeWidth={2.4} />
              })()}
              {detail.materialization}
            </span>
          )}
          {detail?.execution_mode && <span className="node__badge">{detail.execution_mode}</span>}
          {detail?.tags.map((tag) => (
            <span key={tag} className="node__badge">
              #{tag}
            </span>
          ))}
        </div>

        <div className="overlay__title-row">
          <h2 className="overlay__title">{detail?.name ?? activeId.split('.').pop()}</h2>
          <button className="btn btn--icon btn--ghost" onClick={closeOverlay} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        {detail?.description && <p className="overlay__desc">{detail.description}</p>}

        <div className="overlay__actions">
          <button className="btn btn--sm" onClick={focusLineage} title="Select the full lineage of this model">
            <GitBranch size={13} /> Select lineage
          </button>

          {detail?.dbt_run_command && (
            <button className="btn btn--sm" onClick={() => void copyRunCommand()} title={detail.dbt_run_command}>
              {copied ? <Check size={13} color="var(--ok)" /> : <Play size={13} />} dbt run
            </button>
          )}

          {detail?.bigquery && (
            <a
              className="btn btn--sm"
              href={detail.bigquery.console_url}
              target="_blank"
              rel="noreferrer"
              title={`${detail.bigquery.project}.${detail.bigquery.dataset}.${detail.bigquery.table}`}
            >
              <Database size={13} /> BigQuery <ExternalLink size={11} />
            </a>
          )}

          {detail?.bigquery?.query_url && (
            <a
              className="btn btn--sm"
              href={detail.bigquery.query_url}
              target="_blank"
              rel="noreferrer"
              title="Open the compiled SQL in the BigQuery editor"
            >
              <Code2 size={13} /> Run in BQ <ExternalLink size={11} />
            </a>
          )}
        </div>
      </header>

      <nav className="tabs">
        <button className="tab" data-active={tab === 'overview'} onClick={() => setTab('overview' satisfies OverlayTab)}>
          <Info size={13} /> Overview
        </button>
        <button className="tab" data-active={tab === 'code'} onClick={() => setTab('code')}>
          <FileCode2 size={13} /> Code
        </button>
        <button className="tab" data-active={tab === 'schema'} onClick={() => setTab('schema')}>
          <Table2 size={13} /> Schema
          {detail && <span className="tab__count">{detail.columns.length}</span>}
        </button>
        <button className="tab" data-active={tab === 'lineage'} onClick={() => setTab('lineage')}>
          <Layers size={13} /> Lineage
          {detail && (
            <span className="tab__count">{detail.dependencies.length + detail.dependents.length}</span>
          )}
        </button>
      </nav>

      <div className="overlay__body">
        {loading && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-faint)' }}>
            <div className="spinner" />
            Loading model detail…
          </div>
        )}

        {error && <div className="empty">Could not load this model: {error}</div>}

        {detail && !loading && (
          <>
            {tab === 'overview' && <OverviewTab detail={detail} />}
            {tab === 'code' && (
              <CodeViewer compiled={detail.compiled_code} raw={detail.raw_code} fileName={detail.name} />
            )}
            {tab === 'schema' && <SchemaTable columns={detail.columns} />}
            {tab === 'lineage' && (
              <>
                <DependencySection
                  title="Upstream dependencies"
                  icon={<ArrowUpRight size={12} />}
                  nodes={detail.dependencies}
                  emptyText="No upstream models — this is a root node."
                  onPick={(id) => {
                    select([id])
                    void openModel(id)
                  }}
                />
                <DependencySection
                  title="Downstream dependents"
                  icon={<ArrowDownRight size={12} />}
                  nodes={detail.dependents}
                  emptyText="Nothing depends on this model — it is a leaf."
                  onPick={(id) => {
                    select([id])
                    void openModel(id)
                  }}
                />
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function OverviewTab({ detail }: { detail: ModelDetail }) {
  return (
    <>
      <div className="section">
        <div className="section__title">
          <Info size={12} /> Properties
        </div>
        <div className="kv-grid">
          <Kv label="Pipeline" value={detail.pipeline} />
          <Kv label="Materialization" value={detail.materialization} />
          <Kv label="Execution mode" value={detail.execution_mode ?? '–'} />
          <Kv label="Columns" value={formatCount(detail.columns.length)} />
          <Kv label="Rows" value={formatCount(detail.stats?.row_count)} />
          <Kv label="Size" value={formatBytes(detail.stats?.size_bytes)} />
        </div>
      </div>

      <div className="section">
        <div className="section__title">
          <Database size={12} /> Location
        </div>
        <div className="kv-grid">
          <Kv label="Database / project" value={detail.database ?? '–'} mono />
          <Kv label="Schema / dataset" value={detail.schema_name ?? '–'} mono />
          <Kv label="Table / alias" value={detail.alias ?? detail.name} mono />
        </div>
        {detail.original_file_path && (
          <div className="kv" style={{ marginTop: 9 }}>
            <div className="kv__label">dbt file</div>
            <div className="kv__value kv__value--mono">{detail.original_file_path}</div>
          </div>
        )}
        <div className="kv" style={{ marginTop: 9 }}>
          <div className="kv__label">dbt unique_id</div>
          <div className="kv__value kv__value--mono">{detail.id}</div>
        </div>
      </div>

      <div className="section">
        <div className="section__title">
          <Layers size={12} /> Lineage at a glance
        </div>
        <div className="kv-grid">
          <Kv label="Direct upstreams" value={formatCount(detail.dependencies.length)} />
          <Kv label="Direct downstreams" value={formatCount(detail.dependents.length)} />
        </div>
      </div>
    </>
  )
}

function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="kv">
      <div className="kv__label">{label}</div>
      <div className={`kv__value${mono ? ' kv__value--mono' : ''}`}>{value}</div>
    </div>
  )
}

function DependencySection({
  title,
  icon,
  nodes,
  emptyText,
  onPick,
}: {
  title: string
  icon: React.ReactNode
  nodes: NodeRef[]
  emptyText: string
  onPick: (id: string) => void
}) {
  return (
    <div className="section">
      <div className="section__title">
        {icon} {title} <span className="tab__count">{nodes.length}</span>
      </div>

      {nodes.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <div className="dep-list">
          {nodes.map((node) => {
            const Icon = MATERIALIZATION_ICONS[node.materialization]
            return (
              <button key={node.id} className="dep" onClick={() => onPick(node.id)} title={node.id}>
                <span
                  className="result__dot"
                  style={{ background: stageColor(node.stage), color: stageColor(node.stage) }}
                />
                <span className="dep__name">{node.name}</span>
                <span className="dep__badge">
                  <Icon size={11} /> {node.materialization}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
