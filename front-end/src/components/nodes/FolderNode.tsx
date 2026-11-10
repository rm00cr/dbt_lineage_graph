/**
 * Summary node for a collapsed folder box (zones view): stands in for all models of the folder.
 * Styled differently from a model node on purpose (stacked card, big count). Clicking it expands
 * the folder again (handled in GraphCanvas).
 */

import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { ChevronsUpDown, Layers } from 'lucide-react'
import { memo } from 'react'

import type { Stage } from '../../api/types'
import { useStageColor } from '../visual'

export type FolderNodeData = {
  label: string
  count: number
  stage: Stage
  dimmed: boolean
  inFocus: boolean
  active: boolean
  searchHit: boolean
  /** state comparison: some member differs between the two states */
  changed: boolean
}

export type FolderNodeType = Node<FolderNodeData, 'folder'>

function FolderNodeComponent({ data }: NodeProps<FolderNodeType>) {
  const stageColor = useStageColor()
  return (
    <div
      className="fnode"
      style={{ ['--stage-color' as string]: stageColor(data.stage) }}
      data-dimmed={data.dimmed}
      data-in-focus={data.inFocus}
      data-active={data.active}
      data-search-hit={data.searchHit}
      data-change={data.changed ? 'modified' : undefined}
      title={`${data.label}: ${data.count} models collapsed. Click to expand`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div className="fnode__accent" />
      <div className="fnode__body">
        <div className="fnode__name">
          <Layers size={22} strokeWidth={2} />
          <span>{data.label}</span>
        </div>
        <div className="fnode__meta">
          <span className="fnode__pill">{data.count} models</span>
          <span className="fnode__hint">
            <ChevronsUpDown size={13} /> expand
          </span>
        </div>
      </div>
    </div>
  )
}

export const FolderNode = memo(FolderNodeComponent)
