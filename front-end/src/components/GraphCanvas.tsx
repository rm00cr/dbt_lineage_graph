/**
 * GraphCanvas (AP-2): React Flow canvas with dagre layout, focus mode, multi-selection,
 * area select, mini-map and optional stage zones.
 *
 * Selection is *controlled*: React Flow reports changes, the Zustand store owns the truth,
 * so search results, the `+model+` selector and the overlay all stay in sync.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  type Node as RFNode,
  type NodeChange,
  ReactFlow,
  ViewportPortal,
  type XYPosition,
  useReactFlow,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { GraphNode } from '../api/types'
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph } from '../graph/layout'
import { useExplorerStore } from '../store/useExplorerStore'
import { ModelNode, type ModelNodeType } from './nodes/ModelNode'
import { STAGE_LABELS, stageColor } from './visual'

const NODE_TYPES = { model: ModelNode }
const PULSE_MS = 1900

export function GraphCanvas() {
  const graph = useExplorerStore((s) => s.graph)
  const layoutMode = useExplorerStore((s) => s.layoutMode)
  const focusMode = useExplorerStore((s) => s.focusMode)
  const showMiniMap = useExplorerStore((s) => s.showMiniMap)
  const selectionDrag = useExplorerStore((s) => s.selectionDrag)
  const selectedIds = useExplorerStore((s) => s.selectedIds)
  const highlightedIds = useExplorerStore((s) => s.highlightedIds)
  const highlightedEdgeIds = useExplorerStore((s) => s.highlightedEdgeIds)
  const activeId = useExplorerStore((s) => s.activeId)
  const centerRequest = useExplorerStore((s) => s.centerRequest)

  const select = useExplorerStore((s) => s.select)
  const openModel = useExplorerStore((s) => s.openModel)
  const clearSelection = useExplorerStore((s) => s.clearSelection)
  const closeOverlay = useExplorerStore((s) => s.closeOverlay)

  const { setCenter, fitView } = useReactFlow()

  const [dragged, setDragged] = useState<Map<string, XYPosition>>(new Map())
  const [pulseId, setPulseId] = useState<string | null>(null)
  const selectionRef = useRef(selectedIds)
  selectionRef.current = selectedIds

  // ------------------------------------------------------------------ layout
  const layout = useMemo(
    () => layoutGraph(graph?.nodes ?? [], graph?.edges ?? [], layoutMode),
    [graph, layoutMode],
  )

  const layoutSignature = `${layoutMode}:${graph?.nodes.length ?? 0}:${graph?.edges.length ?? 0}`
  useEffect(() => {
    setDragged(new Map())
    const timer = window.setTimeout(() => fitView({ duration: 650, padding: 0.18 }), 60)
    return () => window.clearTimeout(timer)
  }, [layoutSignature, fitView])

  // ------------------------------------------------------------------ pulse on jump
  useEffect(() => {
    if (!centerRequest) return
    setPulseId(centerRequest.id)
    const timer = window.setTimeout(() => setPulseId(null), PULSE_MS)
    return () => window.clearTimeout(timer)
  }, [centerRequest])

  // ------------------------------------------------------------------ centering
  useEffect(() => {
    if (!centerRequest) return
    const position = dragged.get(centerRequest.id) ?? layout.positions.get(centerRequest.id)
    if (!position) return
    setCenter(position.x + NODE_WIDTH / 2, position.y + NODE_HEIGHT / 2, {
      zoom: 1.05,
      duration: 700,
    })
    // `dragged` intentionally not a dependency: we only centre on an explicit request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerRequest, layout, setCenter])

  // ------------------------------------------------------------------ derived nodes/edges
  const isolating = focusMode === 'isolate' && highlightedIds.size > 0

  const visibleIds = useMemo(() => {
    if (!graph) return new Set<string>()
    if (!isolating) return new Set(graph.nodes.map((n) => n.id))
    return new Set(graph.nodes.filter((n) => highlightedIds.has(n.id)).map((n) => n.id))
  }, [graph, isolating, highlightedIds])

  const nodes = useMemo<ModelNodeType[]>(() => {
    if (!graph) return []
    const dimming = focusMode !== 'off' && highlightedIds.size > 0

    return graph.nodes
      .filter((node) => visibleIds.has(node.id))
      .map((node) => ({
        id: node.id,
        type: 'model' as const,
        position: dragged.get(node.id) ?? layout.positions.get(node.id) ?? { x: 0, y: 0 },
        // Explicit dimensions: the nodes are fully controlled, so React Flow never writes
        // measurements back into them — without this the mini-map stays empty.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        selected: selectedIds.has(node.id),
        data: {
          node,
          dimmed: dimming && !highlightedIds.has(node.id),
          active: activeId === node.id,
          searchHit: pulseId === node.id,
        },
      }))
  }, [graph, visibleIds, dragged, layout, selectedIds, highlightedIds, focusMode, activeId, pulseId])

  const edges = useMemo(() => {
    if (!graph) return []
    const dimming = focusMode !== 'off' && highlightedEdgeIds.size > 0

    return graph.edges
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
      .map((edge) => {
        const highlighted = highlightedEdgeIds.has(edge.id)
        const classes = [
          highlighted ? 'edge--highlight' : dimming ? 'edge--dim' : '',
          edge.cross_pipeline ? 'edge--cross' : '',
        ]
          .filter(Boolean)
          .join(' ')

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          className: classes,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color: highlighted ? '#6366f1' : 'rgba(148,163,184,0.4)',
          },
        }
      })
  }, [graph, visibleIds, highlightedEdgeIds, focusMode])

  // ------------------------------------------------------------------ interaction
  const onNodesChange = useCallback(
    (changes: NodeChange<ModelNodeType>[]) => {
      const moved: [string, XYPosition][] = []
      const selectionAdds: string[] = []
      const selectionRemoves: string[] = []

      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moved.push([change.id, change.position])
        } else if (change.type === 'select') {
          ;(change.selected ? selectionAdds : selectionRemoves).push(change.id)
        }
      }

      if (moved.length > 0) {
        setDragged((prev) => {
          const next = new Map(prev)
          for (const [id, position] of moved) next.set(id, position)
          return next
        })
      }

      if (selectionAdds.length > 0 || selectionRemoves.length > 0) {
        const next = new Set(selectionRef.current)
        for (const id of selectionAdds) next.add(id)
        for (const id of selectionRemoves) next.delete(id)
        if (next.size !== selectionRef.current.size || [...next].some((id) => !selectionRef.current.has(id))) {
          select([...next])
        }
      }
    },
    [select],
  )

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: RFNode) => {
      void openModel(node.id, { center: false })
    },
    [openModel],
  )

  const onPaneClick = useCallback(() => {
    clearSelection()
    closeOverlay()
  }, [clearSelection, closeOverlay])

  return (
    <div className={`canvas${activeId ? ' canvas--with-overlay' : ''}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        selectionOnDrag={selectionDrag}
        panOnDrag={selectionDrag ? [1, 2] : true}
        multiSelectionKeyCode={['Meta', 'Control']}
        selectionKeyCode="Shift"
        deleteKeyCode={null}
        minZoom={0.1}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        defaultEdgeOptions={{ type: 'default' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="rgba(148,163,184,0.16)" />
        <Controls position="bottom-right" showInteractive={false} />
        {showMiniMap && (
          <MiniMap
            position="top-right"
            pannable
            zoomable
            maskColor="rgba(8, 11, 18, 0.72)"
            nodeColor={(node) => stageColor((node.data as { node: GraphNode }).node.stage)}
            nodeStrokeWidth={0}
            style={{ width: 190, height: 130 }}
          />
        )}

        {layoutMode === 'lanes' && (
          <ViewportPortal>
            {layout.lanes.map((lane) => (
              <div
                key={lane.stage}
                className="lane"
                style={{
                  ['--stage-color' as string]: stageColor(lane.stage),
                  transform: `translate(${lane.x}px, ${lane.y}px)`,
                  width: lane.width,
                  height: lane.height,
                }}
              >
                <div className="lane__label" style={{ ['--stage-color' as string]: stageColor(lane.stage) }}>
                  {STAGE_LABELS[lane.stage]}
                  <span className="lane__count">{lane.count}</span>
                </div>
              </div>
            ))}
          </ViewportPortal>
        )}
      </ReactFlow>
    </div>
  )
}
