/**
 * Custom React Flow node (AP-2): stage colour, materialization badge, large label,
 * zoom-dependent detail (feature 1.6 / 1.8).
 *
 * Stacked execution modes: a node of a stacked pipeline gets a row of mode tabs above its
 * card (the front mode solid, back modes outlined, click one to bring it to the front) and
 * an offset back card per other mode that has the model. A model that exists only in back
 * modes is drawn as a dashed ghost card.
 */

import { Handle, type Node, type NodeProps, Position, useStore } from '@xyflow/react'
import { memo } from 'react'

import type { GraphNode } from '../../api/types'
import { MAX_TRACE_ROWS, type TracedColumn, rowHandleId, visibleRows } from '../../graph/columnTrace'
import { CHANGE_LABELS, CHANGE_SYMBOLS } from '../../graph/diff'
import { NODE_HEIGHT, NODE_WIDTH } from '../../graph/layout'
import { STACK_HEAD, STACK_OFFSET, backLayers, isGhost, isStacked, stackTabs, tabDepth } from '../../graph/stack'
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
  /** explicit height: column rows (2.3) and / or the stacked-modes head */
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
  // stacked execution modes
  const stacked = isStacked(node)
  const ghost = isGhost(node)
  const bringModeToFront = useExplorerStore((s) => s.bringModeToFront)
  const cardHeight = stacked ? (height ?? NODE_HEIGHT + STACK_HEAD) - STACK_HEAD : height

  const card = (
    <div
      className={`node${compact ? ' node--compact' : ''}${rows.length > 0 ? ' node--traced' : ''}`}
      style={{
        ['--stage-color' as string]: stageColor(node),
        ...(cardHeight ? { height: cardHeight } : {}),
        ...(stacked ? { position: 'absolute', top: STACK_HEAD, left: 0 } : {}),
      }}
      data-ghost={ghost || undefined}
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

  if (!stacked) return card

  const layers = backLayers(node)
  return (
    <div
      className="stack"
      style={{
        width: NODE_WIDTH,
        height: (cardHeight ?? NODE_HEIGHT) + STACK_HEAD,
        ['--stage-color' as string]: stageColor(node),
      }}
      data-dimmed={dimmed}
      data-ghost={ghost || undefined}
    >
      {/* each tab stands on the top edge of its own card: the front tab on the front card,
          back tabs on their offset back cards, so they step up like folder tabs */}
      <div className="stack__tabs" style={{ height: STACK_HEAD }}>
        {stackTabs(node).map((tab, index) => (
          <button
            key={tab.mode}
            type="button"
            className="stack__tab nodrag"
            style={{ marginBottom: tabDepth(node, index) * STACK_OFFSET }}
            data-front={tab.front}
            data-differs={tab.differs || undefined}
            disabled={tab.front}
            title={
              tab.front
                ? `${tab.mode} is in front`
                : `${node.name} in ${tab.mode}${tab.differs ? ': compiles to other SQL' : ''} - click to bring ${tab.mode} to the front`
            }
            onClick={(event) => {
              event.stopPropagation()
              void bringModeToFront(node.pipeline, tab.mode)
            }}
          >
            <span className="stack__tab-name">{tab.mode}</span>
            {tab.differs && <span className="stack__differs">≠</span>}
          </button>
        ))}
      </div>
      {/* back cards, furthest first; offset up and right so they peek out behind the card */}
      {Array.from({ length: layers }, (_, i) => layers - i).map((depth) => (
        <div
          key={depth}
          className="stack__layer"
          style={{
            ['--stage-color' as string]: stageColor(node),
            top: STACK_HEAD - depth * STACK_OFFSET,
            left: depth * STACK_OFFSET,
            height: cardHeight ?? NODE_HEIGHT,
          }}
        />
      ))}
      {card}
    </div>
  )
}

export const ModelNode = memo(ModelNodeComponent)
