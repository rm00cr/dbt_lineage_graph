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
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { GraphEdge, GraphNode } from '../api/types'
import { boundaryViolations } from '../graph/boundary'
import { COLLAPSED_NODE_HEIGHT, COLLAPSED_PREFIX, isCollapsedNodeId } from '../graph/collapse'
import { edgeHandles, traceNodeHeight } from '../graph/columnTrace'
import { NODE_HEIGHT, NODE_WIDTH, cardHeight, layoutGraph } from '../graph/layout'
import { shownView, touches as touchesIn, visibleSubgraph } from '../graph/visible'
import { STACK_HEAD, isStacked } from '../graph/stack'
import { useExplorerStore } from '../store/useExplorerStore'
import { useTheme } from '../theme/useTheme'
import { FolderNode, type FolderNodeType } from './nodes/FolderNode'
import { ModelNode, type ModelNodeType } from './nodes/ModelNode'
import { useChangeColor, useStages } from './visual'

const NODE_TYPES = { model: ModelNode, folder: FolderNode }
const PULSE_MS = 1900

export function GraphCanvas() {
  const graph = useExplorerStore((s) => s.graph)
  const layoutMode = useExplorerStore((s) => s.layoutMode)
  const zoneMode = useExplorerStore((s) => s.zoneMode)
  const layers = useExplorerStore((s) => s.meta?.layers)
  const collapsedFolders = useExplorerStore((s) => s.collapsedFolders)
  const toggleFolder = useExplorerStore((s) => s.toggleFolder)
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
  const { color: stageColor, label: stageLabel } = useStages()
  const changeColor = useChangeColor()

  const [dragged, setDragged] = useState<Map<string, XYPosition>>(new Map())
  const [pulseId, setPulseId] = useState<string | null>(null)
  const selectionRef = useRef(selectedIds)
  selectionRef.current = selectedIds

  // ------------------------------------------------------------------ layout
  // collapsed folder boxes (zones > groups) are replaced by one summary node each; the same
  // rule (graph/visible.ts) decides what an export contains
  const view = useMemo(
    () =>
      shownView({
        graph,
        layoutMode,
        zoneMode,
        collapsedFolders,
        // a column trace needs its models: their folders stay open while it is shown
        keep: traceView?.nodeIds,
      }),
    [graph, layoutMode, zoneMode, collapsedFolders, traceView],
  )

  // traced nodes (2.3) grow by their column rows; the layout makes room for them
  // nodes of stacked execution modes get head room above the card for mode tabs + back cards
  const heights = useMemo(() => {
    // every card is as tall as its name needs; traced columns and the stack head add to it
    const map = new Map<string, number>()
    for (const node of view.nodes) {
      // a collapsed folder's summary node has a fixed height
      if (view.members.has(node.id)) {
        map.set(node.id, COLLAPSED_NODE_HEIGHT)
        continue
      }
      let height = traceNodeHeight(cardHeight(node), traceView?.columnsByNode.get(node.id))
      if (isStacked(node)) height += STACK_HEAD
      map.set(node.id, height)
    }
    return map
  }, [traceView, view])

  const layout = useMemo(
    () =>
      layoutGraph(view.nodes, view.edges, layoutMode, heights, {
        zones: zoneMode,
        stageOrder: layers?.map((l) => l.name),
      }),
    [view, layoutMode, heights, zoneMode, layers],
  )

  // moved nodes would sit at stale spots once boxes collapse / expand
  const collapseSignature = [...view.members.keys()].sort().join('|')
  useEffect(() => {
    setDragged(new Map())
  }, [collapseSignature])

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

  const layoutSignature = `${layoutMode}:${layoutMode === 'lanes' ? zoneMode : ''}:${graph?.nodes.length ?? 0}:${graph?.edges.length ?? 0}`
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
  const centeredFor = useRef<typeof centerRequest>(null)
  useEffect(() => {
    if (!centerRequest) return
    const shownAs = view.representative.get(centerRequest.id) ?? centerRequest.id
    if (isCollapsedNodeId(shownAs)) {
      // the target sits in a collapsed folder: open it, the next layout run centres on it
      toggleFolder(shownAs.slice(COLLAPSED_PREFIX.length))
      return
    }
    const position = dragged.get(shownAs) ?? layout.positions.get(shownAs)
    if (!position || centeredFor.current === centerRequest) return
    centeredFor.current = centerRequest
    setCenter(position.x + NODE_WIDTH / 2, position.y + (heights.get(shownAs) ?? NODE_HEIGHT) / 2, {
      zoom: 1.05,
      duration: 700,
    })
    // `dragged` intentionally not a dependency: we only centre on an explicit request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerRequest, layout, view, setCenter, toggleFolder])

  // ------------------------------------------------------------------ derived nodes/edges
  /** a summary node counts as in `ids` when any model it stands for is */
  const touches = useCallback((id: string, ids: ReadonlySet<string>) => touchesIn(view, id, ids), [view])

  // shared with the export, so an export always contains what the canvas shows
  const visibleIds = useMemo(() => visibleSubgraph(view, focusMode, highlightedIds).ids, [view, focusMode, highlightedIds])

  const nodes = useMemo<(ModelNodeType | FolderNodeType)[]>(() => {
    if (!graph) return []
    const dimming = focusMode !== 'off' && highlightedIds.size > 0

    return view.nodes
      .filter((node) => visibleIds.has(node.id))
      .map((node) => {
        const common = {
          id: node.id,
          position: dragged.get(node.id) ?? layout.positions.get(node.id) ?? { x: 0, y: 0 },
          // Explicit dimensions: the nodes are fully controlled, so React Flow never writes
          // measurements back into them — without this the mini-map stays empty.
          width: NODE_WIDTH,
          height: heights.get(node.id) ?? NODE_HEIGHT,
        }
        const inFocus = dimming && touches(node.id, highlightedIds)
        const dimmed = dimming && !inFocus
        const members = view.members.get(node.id)
        if (members) {
          return {
            ...common,
            type: 'folder' as const,
            selectable: false,
            data: {
              label: node.name,
              count: members.length,
              stage: node.stage,
              dimmed,
              inFocus,
              active: activeId !== null && members.includes(activeId),
              searchHit: pulseId !== null && members.includes(pulseId),
              // state comparison: what the folder's models changed (mixed -> modified)
              change: node.change ?? undefined,
            },
          }
        }
        return {
          ...common,
          type: 'model' as const,
          selected: selectedIds.has(node.id),
          data: {
            node,
            dimmed,
            inFocus,
            active: activeId === node.id,
            searchHit: pulseId === node.id,
            traceColumns: traceView?.columnsByNode.get(node.id),
            height: heights.get(node.id),
          },
        }
      })
  }, [graph, view, visibleIds, dragged, layout, heights, traceView, selectedIds, highlightedIds, focusMode, activeId, pulseId, touches])

  const accentColor = theme === 'light' ? '#4f46e5' : '#6366f1'
  const edgeColor = theme === 'light' ? 'rgba(71,85,105,0.5)' : 'rgba(148,163,184,0.4)'

  // cross-pipeline edges that break the boundary convention (only OUT -> SRC may cross)
  const violations = useMemo(() => boundaryViolations(graph?.nodes ?? [], graph?.edges ?? []), [graph])
  /** merged edges (into / out of a summary node) stand for several real edges */
  const standsFor = useCallback((id: string) => view.edgeMembers.get(id) ?? [id], [view])
  const isViolation = useCallback((id: string) => standsFor(id).some((e) => violations.has(e)), [standsFor, violations])

  const edges = useMemo(() => {
    if (!graph) return []
    const dimming = focusMode !== 'off' && highlightedEdgeIds.size > 0
    const crossClass = (edge: GraphEdge) =>
      [
        edge.cross_pipeline ? `edge--cross${isViolation(edge.id) ? ' edge--violation' : ''}` : '',
        edge.change === 'added' || edge.change === 'removed' ? `edge--${edge.change}` : '',
        edge.front === false ? 'edge--back' : '',
      ]
        .filter(Boolean)
        .join(' ')
    // state comparison: added / removed edges keep their colour, also on the arrow head
    const arrowColor = (edge: GraphEdge, fallback: string) =>
      edge.change === 'added' || edge.change === 'removed' ? changeColor(edge.change) : fallback

    // while a column is traced, the model edges on its path are replaced by column edges
    if (traceView) {
      const modelEdges = view.edges
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

    return view.edges
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
      .map((edge) => {
        const highlighted = standsFor(edge.id).some((e) => highlightedEdgeIds.has(e))
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
  }, [graph, view, visibleIds, highlightedEdgeIds, focusMode, accentColor, edgeColor, traceView, isViolation, standsFor, changeColor])

  // ------------------------------------------------------------------ interaction
  const onNodesChange = useCallback(
    (changes: NodeChange<ModelNodeType | FolderNodeType>[]) => {
      const moved: [string, XYPosition][] = []
      const selectionAdds: string[] = []
      const selectionRemoves: string[] = []

      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moved.push([change.id, change.position])
        } else if (change.type === 'select' && !isCollapsedNodeId(change.id)) {
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
      if (isCollapsedNodeId(node.id)) {
        toggleFolder(node.id.slice(COLLAPSED_PREFIX.length))
        return
      }
      void openModel(node.id, { center: false })
    },
    [openModel, toggleFolder],
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
              const data = node.data as { node?: GraphNode; stage?: GraphNode['stage'] }
              if (!data.node) return stageColor(data.stage ?? 'other') // collapsed folder
              return comparing ? changeColor(data.node.change) : stageColor(data.node)
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
                  {stageLabel(lane.stage)}
                  <span className="lane__count">{lane.count}</span>
                </div>
              </div>
            ))}
            {layout.folders.map((box) => {
              const open = !view.members.has(`${COLLAPSED_PREFIX}${box.key}`)
              const Chevron = open ? ChevronDown : ChevronRight
              // a collapsed box holds one summary node: the real model count is on that node
              const count = view.members.get(`${COLLAPSED_PREFIX}${box.key}`)?.length ?? box.count
              return (
                <div
                  key={box.key}
                  className={`folder-band ${box.folder ? '' : 'folder-band--root'}`}
                  style={{
                    ['--stage-color' as string]: stageColor(box.stage),
                    transform: `translate(${box.x}px, ${box.y}px)`,
                    width: box.width,
                    height: box.height,
                  }}
                >
                  <button
                    type="button"
                    className="folder-band__label nopan"
                    aria-expanded={open}
                    title={open ? 'Collapse this group' : 'Expand this group'}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleFolder(box.key)
                    }}
                  >
                    <Chevron size={14} className="folder-band__chevron" />
                    {box.folder ?? '(root)'}
                    <span className="row-band__count">{count}</span>
                  </button>
                </div>
              )
            })}
          </ViewportPortal>
        )}
      </ReactFlow>
    </div>
  )
}
