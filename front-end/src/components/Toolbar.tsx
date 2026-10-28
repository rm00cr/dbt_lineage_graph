/**
 * Toolbar (AP-2): layout mode, focus mode, mini-map, area-select, zoom-to-fit,
 * the dbt-style `+model+` multi-selection field and the pipeline/stage filters.
 */

import { useReactFlow } from '@xyflow/react'
import {
  Columns3,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  Filter,
  GitBranch,
  Layers,
  Map as MapIcon,
  Maximize2,
  MousePointerSquareDashed,
  RefreshCw,
  Workflow,
  X,
} from 'lucide-react'
import { useState } from 'react'

import { useExplorerStore } from '../store/useExplorerStore'
import { STAGE_LABELS, copyToClipboard, stageColor } from './visual'

const FOCUS_LABEL = { off: 'Focus off', dim: 'Focus: dim', isolate: 'Focus: isolate' } as const
const FOCUS_ICON = { off: EyeOff, dim: Eye, isolate: Crosshair } as const

interface ToolbarProps {
  onToast: (message: string) => void
}

export function Toolbar({ onToast }: ToolbarProps) {
  const layoutMode = useExplorerStore((s) => s.layoutMode)
  const setLayoutMode = useExplorerStore((s) => s.setLayoutMode)
  const focusMode = useExplorerStore((s) => s.focusMode)
  const cycleFocusMode = useExplorerStore((s) => s.cycleFocusMode)
  const showMiniMap = useExplorerStore((s) => s.showMiniMap)
  const toggleMiniMap = useExplorerStore((s) => s.toggleMiniMap)
  const selectionDrag = useExplorerStore((s) => s.selectionDrag)
  const toggleSelectionDrag = useExplorerStore((s) => s.toggleSelectionDrag)

  const selectorInput = useExplorerStore((s) => s.selectorInput)
  const setSelectorInput = useExplorerStore((s) => s.setSelectorInput)
  const applySelector = useExplorerStore((s) => s.applySelector)
  const selectedIds = useExplorerStore((s) => s.selectedIds)
  const clearSelection = useExplorerStore((s) => s.clearSelection)
  const expandSelectionLineage = useExplorerStore((s) => s.expandSelectionLineage)
  const dbtSelectorString = useExplorerStore((s) => s.dbtSelectorString)

  const filters = useExplorerStore((s) => s.filters)
  const setFilters = useExplorerStore((s) => s.setFilters)
  const meta = useExplorerStore((s) => s.meta)
  const graph = useExplorerStore((s) => s.graph)
  const refresh = useExplorerStore((s) => s.refresh)

  const [showFilters, setShowFilters] = useState(false)
  const { fitView } = useReactFlow()

  const FocusIcon = FOCUS_ICON[focusMode]
  const pipelines = meta?.pipelines ?? graph?.stats.pipelines ?? []
  const stages = meta?.stages ?? graph?.stats.stages ?? []

  const togglePipeline = (pipeline: string) => {
    const next = filters.pipelines.includes(pipeline)
      ? filters.pipelines.filter((p) => p !== pipeline)
      : [...filters.pipelines, pipeline]
    void setFilters({ pipelines: next })
  }

  const toggleStage = (stage: string) => {
    const next = filters.stages.includes(stage)
      ? filters.stages.filter((s) => s !== stage)
      : [...filters.stages, stage]
    void setFilters({ stages: next })
  }

  const copySelector = async () => {
    const selector = dbtSelectorString()
    if (!selector) {
      onToast('Nothing selected')
      return
    }
    const ok = await copyToClipboard(`dbt run --select ${selector}`)
    onToast(ok ? 'dbt run command copied' : 'Copy failed')
  }

  return (
    <div className="toolbar">
      <div className="toolbar__row">
        <button
          className={`btn ${layoutMode === 'dag' ? 'btn--active' : ''}`}
          onClick={() => setLayoutMode('dag')}
          title="Directed graph layout (dagre, left to right)"
        >
          <Workflow size={14} /> DAG
        </button>
        <button
          className={`btn ${layoutMode === 'lanes' ? 'btn--active' : ''}`}
          onClick={() => setLayoutMode('lanes')}
          title="Stage zones: src / int / out as columns"
        >
          <Columns3 size={14} /> Stage zones
        </button>

        <span className="toolbar__divider" />

        <button
          className={`btn ${focusMode !== 'off' ? 'btn--active' : ''}`}
          onClick={cycleFocusMode}
          title="Focus mode: dim or isolate everything outside the selected lineage (F)"
        >
          <FocusIcon size={14} /> {FOCUS_LABEL[focusMode]}
        </button>

        <button
          className={`btn btn--icon ${showMiniMap ? 'btn--active' : ''}`}
          onClick={toggleMiniMap}
          title="Toggle mini-map (M)"
        >
          <MapIcon size={14} />
        </button>

        <button
          className={`btn btn--icon ${selectionDrag ? 'btn--active' : ''}`}
          onClick={toggleSelectionDrag}
          title="Area select with left drag (otherwise Shift + drag)"
        >
          <MousePointerSquareDashed size={14} />
        </button>

        <button
          className="btn btn--icon"
          onClick={() => fitView({ duration: 600, padding: 0.18 })}
          title="Zoom to fit (Z)"
        >
          <Maximize2 size={14} />
        </button>

        <span className="toolbar__divider" />

        <button
          className={`btn btn--icon ${showFilters ? 'btn--active' : ''}`}
          onClick={() => setShowFilters((v) => !v)}
          title="Filters"
        >
          <Filter size={14} />
        </button>

        <button className="btn btn--icon" onClick={() => void refresh()} title="Reload graph from API">
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="toolbar__row">
        <span className="toolbar__label">Select</span>
        <div className="selector-field">
          <GitBranch size={13} color="var(--text-faint)" />
          <input
            value={selectorInput}
            placeholder="+int_mfp_contracts+   tag:mfp   stage:out"
            spellCheck={false}
            onChange={(event) => setSelectorInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applySelector(event.currentTarget.value)
              if (event.key === 'Escape') event.currentTarget.blur()
            }}
          />
          {selectedIds.size > 0 && <span className="selector-count">{selectedIds.size}</span>}
        </div>

        <button
          className="btn btn--sm"
          onClick={() => applySelector(selectorInput)}
          title="Resolve the selector and select the matching nodes"
        >
          Apply
        </button>
        <button
          className="btn btn--sm"
          onClick={expandSelectionLineage}
          disabled={selectedIds.size === 0}
          title="Grow the selection to the full upstream + downstream lineage"
        >
          <Layers size={13} /> + lineage +
        </button>
        <button className="btn btn--sm" onClick={() => void copySelector()} title="Copy dbt run command">
          <Copy size={13} /> dbt run
        </button>
        {selectedIds.size > 0 && (
          <button className="btn btn--sm btn--ghost" onClick={clearSelection} title="Clear selection (Esc)">
            <X size={13} />
          </button>
        )}
      </div>

      {showFilters && (
        <div className="toolbar__row">
          <span className="toolbar__label">Pipeline</span>
          {pipelines.map((pipeline) => (
            <button
              key={pipeline}
              className={`btn btn--sm ${filters.pipelines.includes(pipeline) ? 'btn--active' : ''}`}
              onClick={() => togglePipeline(pipeline)}
            >
              {pipeline}
            </button>
          ))}

          <span className="toolbar__divider" />
          <span className="toolbar__label">Stage</span>
          {stages.map((stage) => (
            <button
              key={stage}
              className={`btn btn--sm ${filters.stages.includes(stage) ? 'btn--active' : ''}`}
              onClick={() => toggleStage(stage)}
              style={
                filters.stages.includes(stage)
                  ? { color: stageColor(stage as 'src'), borderColor: stageColor(stage as 'src') }
                  : undefined
              }
            >
              {STAGE_LABELS[stage as 'src'] ?? stage}
            </button>
          ))}

          <span className="toolbar__divider" />
          <button
            className={`btn btn--sm ${filters.includeSources ? 'btn--active' : ''}`}
            onClick={() => void setFilters({ includeSources: !filters.includeSources })}
          >
            Sources
          </button>
        </div>
      )}
    </div>
  )
}
