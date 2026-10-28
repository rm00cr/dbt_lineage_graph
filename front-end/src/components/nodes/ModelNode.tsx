/**
 * Custom React Flow node (AP-2): stage colour, materialization badge, large label,
 * zoom-dependent detail (feature 1.6 / 1.8).
 */

import { Handle, type Node, type NodeProps, Position, useStore } from '@xyflow/react'
import { memo } from 'react'

import type { GraphNode } from '../../api/types'
import { MATERIALIZATION_ICONS, stageColor } from '../visual'

export type ModelNodeData = {
  node: GraphNode
  dimmed: boolean
  active: boolean
  searchHit: boolean
}

export type ModelNodeType = Node<ModelNodeData, 'model'>

const COMPACT_ZOOM = 0.55

function ModelNodeComponent({ data, selected }: NodeProps<ModelNodeType>) {
  const compact = useStore((state) => state.transform[2] < COMPACT_ZOOM)
  const { node, dimmed, active, searchHit } = data
  const Icon = MATERIALIZATION_ICONS[node.materialization] ?? MATERIALIZATION_ICONS.other

  return (
    <div
      className={`node${compact ? ' node--compact' : ''}`}
      style={{ ['--stage-color' as string]: stageColor(node.stage) }}
      data-selected={selected}
      data-active={active}
      data-dimmed={dimmed}
      data-search-hit={searchHit}
      title={node.description ?? node.name}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="node__accent" />

      <div className="node__inner">
        <div className="node__head">
          <span className="node__icon">
            <Icon size={14} strokeWidth={2.2} />
          </span>
          <span className="node__name">{node.name}</span>
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

      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}

export const ModelNode = memo(ModelNodeComponent)
