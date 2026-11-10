/**
 * Custom React Flow node (AP-2): stage colour, materialization badge, large label,
 * zoom-dependent detail (feature 1.6 / 1.8).
 */

import { Handle, type Node, type NodeProps, Position, useStore } from '@xyflow/react'
import { memo } from 'react'

import type { GraphNode } from '../../api/types'
import { MAX_TRACE_ROWS, type TracedColumn, rowHandleId, visibleRows } from '../../graph/columnTrace'
import { CHANGE_LABELS, CHANGE_SYMBOLS } from '../../graph/diff'
import { useExplorerStore } from '../../store/useExplorerStore'
import { MATERIALIZATION_ICONS, useStageColor } from '../visual'

export type ModelNodeData = {
  node: GraphNode
  dimmed: boolean
  /** inside the focused lineage path — gets a positive highlight, not just "not dimmed" */
  inFocus: boolean
  active: boolean
  searchHit: boolean
  /** column-lineage trace (2.3): the traced columns of this node, rendered as rows */
  traceColumns?: TracedColumn[]
  /** explicit height while column rows are shown */
  height?: number
}

export type ModelNodeType = Node<ModelNodeData, 'model'>

const COMPACT_ZOOM = 0.55

function ModelNodeComponent({ data, selected }: NodeProps<ModelNodeType>) {
  const zoomedOut = useStore((state) => state.transform[2] < COMPACT_ZOOM)
  // an image export always shows the full node, whatever the current zoom
  const exporting = useExplorerStore((s) => s.exporting)
  const compact = zoomedOut && !exporting
  const stageColor = useStageColor()
  const { node, dimmed, inFocus, active, searchHit, traceColumns, height } = data
  const rows = traceColumns ? visibleRows(traceColumns) : []
  const hidden = (traceColumns?.length ?? 0) - rows.length
  const Icon = MATERIALIZATION_ICONS[node.materialization] ?? MATERIALIZATION_ICONS.other
  // state comparison: added / removed / modified (unchanged nodes get no tag)
  const change = node.change ?? undefined
  const changed = change && change !== 'unchanged'

  return (
    <div
      className={`node${compact ? ' node--compact' : ''}${rows.length > 0 ? ' node--traced' : ''}`}
      style={{ ['--stage-color' as string]: stageColor(node.stage), ...(height ? { height } : {}) }}
      data-selected={selected}
      data-active={active}
      data-dimmed={dimmed}
      data-in-focus={inFocus}
      data-search-hit={searchHit}
      data-change={change}
      title={changed ? `${node.name} (${CHANGE_LABELS[change]} in the uploaded state)` : (node.description ?? node.name)}
    >
      {/* default handles first: edges without a handle id attach to the first one */}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div className="node__main">
        <div className="node__accent" />

        <div className="node__inner">
          <div className="node__head">
            <span className="node__icon">
              <Icon size={14} strokeWidth={2.2} />
            </span>
            <span className="node__name">{node.name}</span>
            {changed && (
              <span className="node__change" aria-label={CHANGE_LABELS[change]}>
                {CHANGE_SYMBOLS[change]}
                <span className="node__change-label"> {CHANGE_LABELS[change]}</span>
              </span>
            )}
          </div>

          <div className="node__meta">
            <span className="node__badge node__badge--stage">{node.stage}</span>
            <span className="node__badge">
              <Icon size={10} strokeWidth={2.4} />
              {node.materialization}
            </span>
            {node.column_count > 0 && (
              <span className="node__badge node__badge--cols">{node.column_count} cols</span>
            )}
          </div>

          <div className="node__sub">
            {node.pipeline}
            {node.schema_name ? ` · ${node.schema_name}` : ''}
          </div>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="node__cols">
          {rows.map((column) => (
            <div key={column.name} className="node__col" data-role={column.role} title={column.name}>
              <Handle
                id={rowHandleId(column.name, 'in')}
                type="target"
                position={Position.Left}
                isConnectable={false}
              />
              <span className="node__col-name">{column.name}</span>
              {column.role !== 'root' && <span className="node__col-hop">{column.distance}</span>}
              <Handle
                id={rowHandleId(column.name, 'out')}
                type="source"
                position={Position.Right}
                isConnectable={false}
              />
            </div>
          ))}
          {hidden > 0 && (
            <div className="node__col node__col--more" title={`only the first ${MAX_TRACE_ROWS} columns are drawn`}>
              +{hidden} more
            </div>
          )}
        </div>
      )}

    </div>
  )
}

export const ModelNode = memo(ModelNodeComponent)
