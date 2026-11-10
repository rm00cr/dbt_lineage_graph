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

import type { GraphEdge, GraphNode } from '../api/types'
import { boundaryViolations } from '../graph/boundary'
import { edgeHandles, traceNodeHeight } from '../graph/columnTrace'
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph } from '../graph/layout'
import { useExplorerStore } from '../store/useExplorerStore'
import { useTheme } from '../theme/useTheme'
import { ModelNode, type ModelNodeType } from './nodes/ModelNode'
import { STAGE_LABELS, useChangeColor, useStageColor } from './visual'

const NODE_TYPES = { model: ModelNode }
const PULSE_MS = 1900

export function GraphCanvas() {
  const graph = useExplorerStore((s) => s.graph)
  const layoutMode = useExplorerStore((s) => s.layoutMode)
  const zoneMode = useExplorerStore((s) => s.zoneMode)
  const splitPipelines = useExplorerStore((s) => s.splitPipelines)
  const focusMode = useExplorerStore((s) => s.focusMode)
  const showMiniMap = useExplorerStore((s) => s.showMiniMap)
  const selectionDrag = useExplorerStore((s) => s.selectionDrag)
  const selectedIds = useExplorerStore((s) => s.selectedIds)
  const highlightedIds = useExplorerStore((s) => s.highlightedIds)
  const highlightedEdgeIds = useExplorerStore((s) => s.highlightedEdgeIds)
  const activeId = useExplorerStore((s) => s.activeId)
  const centerRequest = useExplorerStore((s) => s.centerRequest)
  const traceView = useExplorerStore((s) => s.columnTrace?.view ?? null)
  const comparing = useExplorerStore((s) => s.compare !== null)

  const select = useExplorerStore((s) => s.select)
  const openModel = useExplorerStore((s) => s.openModel)
  const clearSelection = useExplorerStore((s) => s.clearSelection)
  const closeOverlay = useExplorerStore((s) => s.closeOverlay)

  const { setCenter, fitView, fitBounds, getNodesBounds } = useReactFlow()
  const canvasRef = useRef<HTMLDivElement>(null)
  const theme = useTheme((s) => s.resolved)
  const stageColor = useStageColor()
  const changeColor = useChangeColor()

  const [dragged, setDragged] = useState<Map<string, XYPosition>>(new Map())
  const [pulseId, setPulseId] = useState<string | null>(null)
  const selectionRef = useRef(selectedIds)
  selectionRef.current = selectedIds

  // ------------------------------------------------------------------ layout
  // traced nodes (2.3) grow by their column rows; the layout makes room for them
  const heights = useMemo(() => {
    const map = new Map<string, number>()
    if (!traceView) return map
    for (const [id, columns] of traceView.columnsByNode) map.set(id, traceNodeHeight(NODE_HEIGHT, columns))
    return map
  }, [traceView])

  const layout = useMemo(
    () =>
      layoutGraph(graph?.nodes ?? [], graph?.edges ?? [], layoutMode, heights, { zones: zoneMode, splitPipelines }),
    [graph, layoutMode, heights, zoneMode, splitPipelines],
  )

  /**
   * Fit the viewport: to the traced column path (2.3) while one is shown, otherwise to the
   * whole graph. Reads the trace at call time, so a delayed call never undoes a newer one.
   * The traced path is framed in the part of the canvas the overlay does not cover (same
   * width rule as `.overlay` in global.css).
   */
  const frameView = useCallback(() => {
    const view = useExplorerStore.getState().columnTrace?.view
    if (!view) {
      void fitView({ duration: 650, padding: 0.18 })
      return
    }
    const ids = [...view.nodeIds]
    const width = canvasRef.current?.clientWidth ?? window.innerWidth
    const covered = useExplorerStore.getState().activeId ? Math.min(560, window.innerWidth * 0.46) : 0
    if (covered === 0 || width - covered < 200) {
      void fitView({ nodes: ids.map((id) => ({ id })), duration: 650, padding: 0.22, maxZoom: 1.2 })
      return
    }
    // widen the box to the right so the traced nodes land left of the overlay
    const bounds = getNodesBounds(ids)
    void fitBounds({ ...bounds, width: (bounds.width * width) / (width - covered) }, { duration: 650, padding: 0.12 })
  }, [fitView, fitBounds, getNodesBounds])

  const layoutSignature = `${layoutMode}:${layoutMode === 'lanes' ? `${zoneMode}:${splitPipelines}` : ''}:${graph?.nodes.length ?? 0}:${graph?.edges.length ?? 0}`
  useEffect(() => {
    setDragged(new Map())
    const timer = window.setTimeout(frameView, 60)
    return () => window.clearTimeout(timer)
  }, [layoutSignature, frameView])

  // re-frame whenever a different set of nodes is traced
  const traceSignature = traceView
    ? `${traceView.root.modelId}|${traceView.root.column}|${[...traceView.nodeIds].sort().join(',')}`
    : ''
  useEffect(() => {
    if (!traceSignature) return
    const timer = window.setTimeout(frameView, 80)
    return () => window.clearTimeout(timer)
  }, [traceSignature, frameView])

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
        height: heights.get(node.id) ?? NODE_HEIGHT,
        selected: selectedIds.has(node.id),
        data: {
          node,
          dimmed: dimming && !highlightedIds.has(node.id),
          inFocus: dimming && highlightedIds.has(node.id),
          active: activeId === node.id,
          searchHit: pulseId === node.id,
          traceColumns: traceView?.columnsByNode.get(node.id),
          height: heights.get(node.id),
        },
      }))
  }, [graph, visibleIds, dragged, layout, heights, traceView, selectedIds, highlightedIds, focusMode, activeId, pulseId])

  const accentColor = theme === 'light' ? '#4f46e5' : '#6366f1'
  const edgeColor = theme === 'light' ? 'rgba(71,85,105,0.5)' : 'rgba(148,163,184,0.4)'

  // cross-pipeline edges that break the boundary convention (only OUT -> SRC may cross)
  const violations = useMemo(() => boundaryViolations(graph?.nodes ?? [], graph?.edges ?? []), [graph])

  const edges = useMemo(() => {
    if (!graph) return []
    const dimming = focusMode !== 'off' && highlightedEdgeIds.size > 0
    const crossClass = (edge: GraphEdge) =>
      [
        edge.cross_pipeline ? `edge--cross${violations.has(edge.id) ? ' edge--violation' : ''}` : '',
        edge.change === 'added' || edge.change === 'removed' ? `edge--${edge.change}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    // state comparison: added / removed edges keep their colour, also on the arrow head
    const arrowColor = (edge: GraphEdge, fallback: string) =>
      edge.change === 'added' || edge.change === 'removed' ? changeColor(edge.change) : fallback

    // while a column is traced, the model edges on its path are replaced by column edges
    if (traceView) {
      const modelEdges = graph.edges
        .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
        .filter((edge) => !traceView.modelEdgeIds.has(edge.id))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          className: `edge--dim ${crossClass(edge)}`.trim(),
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: arrowColor(edge, edgeColor) },
        }))
      const columnEdges = traceView.edges
        .filter((edge) => visibleIds.has(edge.source_model) && visibleIds.has(edge.target_model))
        .map((edge) => ({
          id: `col:${edge.id}`,
          source: edge.source_model,
          target: edge.target_model,
          ...edgeHandles(traceView, edge),
          className: `cedge cedge--${edge.kind}`,
          zIndex: 1,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: accentColor },
        }))
      return [...modelEdges, ...columnEdges]
    }

    return graph.edges
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
      .map((edge) => {
        const highlighted = highlightedEdgeIds.has(edge.id)
        const classes = [
          highlighted ? 'edge--highlight' : dimming ? 'edge--dim' : '',
          crossClass(edge),
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
            color: arrowColor(edge, highlighted ? accentColor : edgeColor),
          },
        }
      })
  }, [graph, visibleIds, highlightedEdgeIds, focusMode, accentColor, edgeColor, traceView, violations, changeColor])

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
    <div ref={canvasRef} className={`canvas${activeId ? ' canvas--with-overlay' : ''}`}>
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
        defaultEdgeOptions={{ type: 'default' }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={26}
          size={1.4}
          color={theme === 'light' ? 'rgba(79,70,229,0.22)' : 'rgba(148,163,184,0.16)'}
        />
        <Controls position="bottom-right" showInteractive={false} />
        {showMiniMap && (
          <MiniMap
            position="top-right"
            pannable
            zoomable
            maskColor={theme === 'light' ? 'rgba(226, 232, 240, 0.62)' : 'rgba(8, 11, 18, 0.72)'}
            nodeColor={(node) => {
              const data = (node.data as { node: GraphNode }).node
              return comparing ? changeColor(data.change) : stageColor(data.stage)
            }}
            nodeStrokeWidth={0}
            style={{ width: 190, height: 130 }}
          />
        )}

        {layoutMode === 'lanes' && (
          <ViewportPortal>
            {layout.pipelines.map((band) => (
              <div
                key={band.pipeline}
                className="pipeline-band"
                style={{
                  transform: `translate(${band.x}px, ${band.y}px)`,
                  width: band.width,
                  height: band.height,
                }}
              >
                <div className="pipeline-band__label">
                  {band.pipeline}
                  <span className="row-band__count">{band.count}</span>
                </div>
              </div>
            ))}
            {layout.rows.map((row) => (
              <div
                key={`${row.pipeline ?? ''}:${row.group ?? '__ungrouped__'}`}
                className={`row-band ${row.group ? '' : 'row-band--ungrouped'}`}
                style={{
                  transform: `translate(${row.x}px, ${row.y}px)`,
                  width: row.width,
                  height: row.height,
                }}
              >
                <div className="row-band__label">
                  {row.group ?? 'ungrouped'}
                  <span className="row-band__count">{row.count}</span>
                </div>
              </div>
            ))}
            {layout.lanes.map((lane) => (
              <div
                key={`${lane.pipeline ?? ''}:${lane.stage}`}
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
