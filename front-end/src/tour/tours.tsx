/**
 * Content of the guided tours (started from the Help menu, see useTourStore).
 *
 * Tours run on the demo project (api/mock), so every step has something to show.
 *
 * A step spotlights `target` (CSS selectors, or a function returning them) and explains it.
 * `enter` runs whenever the step is shown, forward or back, and puts the app in exactly the
 * state the step talks about (menus open or closed, comparison loaded or not, ...), so it
 * must be idempotent. `when` drops a step that does not apply to the project; it is
 * evaluated at start, on the demo project.
 *
 * Targets that are not on screen get a centred card, so a missing element never breaks a tour.
 */

import {
  Compass,
  FileSearch,
  GitBranch,
  GitCompare,
  type LucideIcon,
  Move,
  Route,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { MOCK_COMPARE_MODIFIED_ID, mockCompare } from '../api/mock'
import type { GraphNode } from '../api/types'
import { boundaryViolations } from '../graph/boundary'
import { useExplorerStore } from '../store/useExplorerStore'

export interface TourStep {
  /** several selectors are spotlighted together (one ring around all of them) */
  target?: string | string[] | (() => string | string[] | null)
  title: string
  body: ReactNode
  enter?: () => void | Promise<void>
  when?: () => boolean
}

export interface TourDef {
  id: string
  title: string
  summary: string
  icon: LucideIcon
  steps: TourStep[]
  /** suggested on the last step */
  next?: string
}

// ------------------------------------------------------------------ helpers

const store = () => useExplorerStore.getState()

/**
 * The model the tours demonstrate on: the open one if any, else the best connected model
 * (parents and children, preferably intermediate), so focus and lineage have something to show.
 */
export function demoModel(): GraphNode | null {
  const { graph, index, activeId } = store()
  if (!graph) return null
  const open = activeId ? index.byId.get(activeId) : undefined
  if (open && open.resource_type === 'model') return open

  let best: GraphNode | null = null
  let bestScore = -1
  for (const node of graph.nodes) {
    if (node.resource_type !== 'model' || node.front === false) continue
    const up = index.parents.get(node.id)?.length ?? 0
    const down = index.children.get(node.id)?.length ?? 0
    const score = Math.min(up, down) * 10 + Math.min(up + down, 9) + ((node.role ?? node.stage) === 'int' ? 5 : 0) + (node.column_count > 0 ? 3 : 0)
    if (score > bestScore) {
      best = node
      bestScore = score
    }
  }
  return best
}

const cssId = (id: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&'))

const demoNodeSelector = () => {
  const node = demoModel()
  return node ? `.react-flow__node[data-id="${cssId(node.id)}"]` : '.react-flow__node-model'
}

async function openDemo(tab: 'overview' | 'code' | 'schema' | 'lineage') {
  const node = demoModel()
  if (!node) return
  const s = store()
  if (s.activeId === node.id) {
    if (s.overlayTab !== tab) s.setOverlayTab(tab)
  } else {
    await s.openModel(node.id, { tab })
  }
}

/**
 * Resolves once the detail of `id` is loaded (or failed, or another model was opened).
 * openDemo returns at once when the model is already open, possibly with its detail still
 * loading from the previous step.
 */
export function waitForDetail(id: string, timeout = 5000): Promise<void> {
  const settled = () => {
    const s = store()
    return s.activeId !== id || s.detail?.id === id || s.detailError !== null || !s.detailLoading
  }
  if (settled()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      unsubscribe()
      window.clearTimeout(timer)
      resolve()
    }
    const unsubscribe = useExplorerStore.subscribe(() => {
      if (settled()) done()
    })
    const timer = window.setTimeout(done, timeout)
  })
}

/** the demo model's column with the most column-lineage edges */
async function traceDemoColumn() {
  await openDemo('schema')
  const node = demoModel()
  if (node) await waitForDetail(node.id)
  const { detail, columnTrace, traceColumn } = store()
  if (!detail || detail.id !== node?.id) return
  const best = [...detail.columns]
    .map((c) => ({ name: c.name, edges: (c.upstream_count ?? 0) + (c.downstream_count ?? 0) }))
    .sort((a, b) => b.edges - a.edges)[0]
  if (!best || best.edges === 0) return
  if (columnTrace?.modelId === detail.id && columnTrace.column === best.name) return
  await traceColumn(detail.id, best.name, 'both')
}

interface Panels {
  pipelines?: boolean
  tasks?: boolean
  export?: boolean
  filters?: boolean
  dialog?: boolean
}

/** opens exactly the given menus / panels and closes the others */
function showPanels(open: Panels = {}) {
  const s = store()
  if (s.pipelinesOpen !== Boolean(open.pipelines)) s.setPipelinesOpen(Boolean(open.pipelines))
  if (s.tasksOpen !== Boolean(open.tasks)) s.setTasksOpen(Boolean(open.tasks))
  if (s.exportOpen !== Boolean(open.export)) s.setExportOpen(Boolean(open.export))
  if (s.filtersOpen !== Boolean(open.filters)) s.setFiltersOpen(Boolean(open.filters))
  if (s.compareDialogOpen !== Boolean(open.dialog)) s.setCompareDialogOpen(Boolean(open.dialog))
}

/** loads or ends the demo comparison (only ever on the demo project, never on real data) */
async function showComparison(on: boolean) {
  const s = store()
  if (!s.demo) return
  if (!on) {
    if (s.compare) await s.exitCompare()
    return
  }
  if (s.compare) return
  const response = mockCompare()
  useExplorerStore.setState({
    compare: {
      stateId: response.state_id,
      label: response.head.label,
      response,
      changes: new Map(response.changes.map((c) => [c.id, c])),
    },
    // the same clean start as startCompare
    selectedIds: new Set(),
    selectorInput: '',
    columnTrace: null,
    activeId: null,
    detail: null,
    detailError: null,
    detailCache: new Map(),
  })
  await store().init()
}

const selectDemo = () => {
  const node = demoModel()
  if (node) store().select([node.id])
}

const hasFolders = () => store().graph?.nodes.some((n) => n.folder) ?? false
const hasViolations = () => {
  const graph = store().graph
  return graph ? boundaryViolations(graph.nodes, graph.edges).size > 0 : false
}

const K = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>

// ------------------------------------------------------------------ tours

const basics: TourDef = {
  id: 'basics',
  title: 'Getting started',
  summary: 'The main areas of the explorer in a minute',
  icon: Compass,
  next: 'canvas',
  steps: [
    {
      title: 'Welcome to the dbt Lineage Explorer',
      body: (
        <>
          This app draws the lineage of the dbt projects of the data platform: every model, how they feed
          each other, down to single columns. This tour shows the main areas. The Help menu has a deeper
          tour for each of them. Use <K>→</K> / <K>←</K> to move, <K>Esc</K> to leave.
        </>
      ),
    },
    {
      target: '.react-flow',
      title: 'The canvas',
      body: (
        <>
          Data flows from left (sources) to right (outputs). Drag to pan, scroll to zoom, <K>Z</K> fits
          everything back into view. Clicking empty canvas clears the selection and closes the side panel.
        </>
      ),
    },
    {
      target: demoNodeSelector,
      enter: () => {
        const node = demoModel()
        if (node) store().requestCenter(node.id)
      },
      title: 'A model',
      body: 'Every card is a dbt model. The accent colour is its stage (src / int / out), the icon its materialization, and the badge shows the column count. Click a card to open its details.',
    },
    {
      target: '.search',
      title: 'Search',
      body: (
        <>
          Fuzzy-find a model by name, or switch to <em>Columns</em> to search column names across all models.
          Press <K>/</K> from anywhere to jump here.
        </>
      ),
    },
    {
      target: '.toolbar',
      title: 'Toolbar',
      body: 'Layout, focus, mini-map and filters on the first row, the dbt selector field on the second. The tour "Navigating the canvas" explains it all.',
    },
    {
      target: '.legend',
      title: 'Legend',
      body: 'The visual language of the canvas: stage colours and materialization icons, plus change colours while comparing two states.',
    },
    {
      target: '.topbar__stats',
      title: 'Project at a glance',
      body: 'How many models and edges are loaded, which pipelines are shown (click to change), and the background dbt runs.',
    },
    {
      target: '[data-tour="help"]',
      title: 'More tours',
      body: (
        <>
          All tours live in this menu, start any of them whenever you like. <K>?</K> opens it too.
        </>
      ),
    },
  ],
}

const canvas: TourDef = {
  id: 'canvas',
  title: 'Navigating the canvas',
  summary: 'Layouts, groups, focus mode, filters and shortcuts',
  icon: Move,
  next: 'model',
  steps: [
    {
      target: '[data-tour="layout"]',
      enter: () => {
        store().setLayoutMode('dag')
        store().setFocusMode('off')
      },
      title: 'DAG layout',
      body: (
        <>
          A directed graph, left to right: best to follow one chain of models. <K>L</K> switches layouts.
        </>
      ),
    },
    {
      target: '[data-tour="layout"]',
      enter: () => {
        store().setLayoutMode('lanes')
        store().setFocusMode('off')
      },
      title: 'Zones layout',
      body: 'Stages as columns: sources, intermediate and output models line up, so you see at a glance which layer a model belongs to. With several pipelines shown, each gets its own band.',
    },
    {
      target: '.toolbar__zones',
      when: hasFolders,
      enter: () => {
        store().setLayoutMode('lanes')
        store().setZoneMode('folders')
        store().setFocusMode('off')
      },
      title: 'Groups',
      body: 'Inside each stage column, one box per model sub-folder. Click a group header to fold it into a single node; the button next to this switch folds or opens all of them.',
    },
    {
      target: '[data-tour="focus"]',
      enter: () => {
        store().setLayoutMode('dag')
        selectDemo()
        store().setFocusMode('dim')
      },
      title: 'Focus: dim',
      body: (
        <>
          With a model selected, focus dims everything outside its lineage (all upstream and downstream
          models). <K>F</K> cycles off → dim → isolate.
        </>
      ),
    },
    {
      target: '.react-flow',
      enter: () => {
        selectDemo()
        store().setFocusMode('isolate')
      },
      title: 'Focus: isolate',
      body: 'Isolate hides everything else. Exports follow what is shown, so this is also the way to export a single lineage.',
    },
    {
      target: '.react-flow__minimap',
      enter: () => {
        store().setFocusMode('off')
        if (!store().showMiniMap) store().toggleMiniMap()
      },
      title: 'Mini-map',
      body: (
        <>
          The whole graph in small, with the visible part framed. <K>M</K> shows or hides it.
        </>
      ),
    },
    {
      target: '[data-tour="area-select"]',
      enter: () => showPanels(),
      title: 'Selecting several models',
      body: (
        <>
          <K>Shift</K> + drag draws a box that selects every model in it; <K>Ctrl</K> + click adds single
          ones. With this toggle on, a plain drag draws the box (and the canvas pans with the middle mouse
          button).
        </>
      ),
    },
    {
      target: ['[data-tour="filters"]', '[data-tour="filter-row"]'],
      enter: () => showPanels({ filters: true }),
      title: 'Filters',
      body: 'Opens this row to load only some pipelines or stages, or to hide dbt sources. The graph reloads with the filtered set. The arrows next to the filter button reload the graph from the API.',
    },
    {
      target: '.shortcut-hint',
      enter: () => showPanels(),
      title: 'Keyboard shortcuts',
      body: (
        <>
          This strip lists the main ones: <K>/</K> search · <K>F</K> focus · <K>L</K> layout · <K>Z</K> fit ·{' '}
          <K>⇧</K> + drag box select · <K>?</K> help. Also: <K>M</K> mini-map · <K>Esc</K> close / clear ·{' '}
          <K>Alt</K>+<K>Z</K> wrap code.
        </>
      ),
    },
  ],
}

const model: TourDef = {
  id: 'model',
  title: 'Inspecting a model',
  summary: 'The side panel: SQL, columns, dependencies',
  icon: FileSearch,
  next: 'columns',
  steps: [
    {
      target: '.overlay__head',
      enter: () => openDemo('overview'),
      title: 'The model panel',
      body: 'Clicking a model opens this panel. The header shows its stage, materialization, execution mode and tags.',
    },
    {
      // empty when the model has neither a run command nor a BigQuery location
      target: () =>
        (document.querySelector('.overlay__actions')?.childElementCount ?? 0) > 0 ? '.overlay__actions' : '.overlay__head',
      enter: () => openDemo('overview'),
      title: 'Run it, find it',
      body: 'dbt run copies the command that builds just this model. BigQuery opens the table in the cloud console, when the project knows where it is deployed.',
    },
    {
      target: ['.overlay .tabs', '.overlay__body'],
      enter: () => openDemo('overview'),
      title: 'Overview',
      body: 'Properties, where the table lives (database, schema, dbt file, unique_id) and its lineage at a glance.',
    },
    {
      target: ['.overlay .tabs', '.overlay__body'],
      enter: () => openDemo('code'),
      title: 'Code',
      body: (
        <>
          Compiled and raw SQL with highlighting, ready to copy or download. <K>Alt</K>+<K>Z</K> toggles word
          wrap. In pipelines with several execution modes you can show two modes side by side or as a diff.
        </>
      ),
    },
    {
      target: ['.overlay .tabs', '.overlay__body'],
      enter: () => openDemo('schema'),
      title: 'Schema',
      body: 'All columns with type and description, filterable. The ↑ ↓ button on each column counts its direct upstream and downstream columns, and clicking it traces the column (see "Column-level lineage").',
    },
    {
      target: ['.overlay .tabs', '.overlay__body'],
      enter: () => openDemo('lineage'),
      title: 'Lineage',
      body: 'The direct parents and children of the model. Click one to move the panel and the canvas to it.',
    },
    {
      target: '[data-tour="overlay-size"]',
      enter: () => openDemo('overview'),
      title: 'Make room',
      body: (
        <>
          Drag the panel's left edge to resize it, or maximize it over the canvas. The size is remembered.{' '}
          <K>Esc</K> closes the panel.
        </>
      ),
    },
  ],
}

const columns: TourDef = {
  id: 'columns',
  title: 'Column-level lineage',
  summary: 'Trace one column from its origins to its impact',
  icon: Route,
  next: 'select',
  steps: [
    {
      target: '.search__mode',
      title: 'Find a column',
      body: 'Switch search to Columns to find a column in any model. Picking a hit opens the model on its Schema tab and traces the column straight away.',
    },
    {
      target: '.trace-btn:not(:disabled)',
      enter: async () => {
        await openDemo('schema')
        if (store().columnTrace) store().clearColumnTrace()
      },
      title: 'Trace from the schema',
      body: 'Or start from a model: each column in the Schema tab has a trace button with its direct upstream ↑ and downstream ↓ column counts. A dash means the SQL could not be parsed.',
    },
    {
      target: '.trace-bar',
      enter: traceDemoColumn,
      title: 'The trace',
      body: 'Here the busiest column of this model is traced. The bar names it, counts the columns and models involved and switches the direction: upstream (where it comes from), downstream (what it affects) or both.',
    },
    {
      target: '.react-flow',
      enter: traceDemoColumn,
      title: 'On the canvas',
      body: 'Models in the trace list the involved columns with their distance in hops. The edge styles show how a column is derived; the bar has their legend.',
    },
    {
      target: '.trace-route',
      enter: traceDemoColumn,
      when: () => (store().graph?.stats.pipelines.length ?? 0) > 1,
      title: 'Across pipelines',
      body: 'When a trace crosses pipelines, this route shows the pipelines it runs through, from origins to impact.',
    },
    {
      target: '.trace-bar',
      enter: traceDemoColumn,
      title: 'Stop tracing',
      body: (
        <>
          <K>Esc</K> or the × ends the trace. Tracing another column replaces it.
        </>
      ),
    },
  ],
}

const select: TourDef = {
  id: 'select',
  title: 'Selecting & running',
  summary: 'dbt selector syntax and ready-made dbt commands',
  icon: GitBranch,
  next: 'compare',
  steps: [
    {
      target: '.selector-field',
      enter: () => {
        const node = demoModel()
        // coming back from Apply: drop its selection (clearSelection also empties the field)
        if (store().selectedIds.size > 0) store().clearSelection()
        if (node) store().setSelectorInput(`+${node.name}+`)
      },
      title: 'dbt selectors',
      body: (
        <>
          Type dbt selection syntax: <code>+model+</code> (with all ancestors and descendants),{' '}
          <code>2+model</code> (two levels up), <code>tag:x</code>, <code>stage:out</code>,{' '}
          <code>folder:x</code>, <code>pipeline:x</code>, <code>materialization:incremental</code>. A space
          means union, a comma intersection.
        </>
      ),
    },
    {
      target: '.selector-field',
      enter: () => {
        const node = demoModel()
        if (node) store().applySelector(`+${node.name}+`)
      },
      title: 'Apply',
      body: (
        <>
          <K>Enter</K> or Apply selects the matching models; the badge counts them and the canvas highlights
          them.
        </>
      ),
    },
    {
      target: '[data-tour="dbt-run"]',
      title: 'Copy the dbt command',
      body: 'Copies dbt run --select … for the current selection, ready to paste into a terminal. The model panel has the same button for a single model.',
    },
    {
      target: '[data-tour="boundary"]',
      when: hasViolations,
      title: 'Pipeline boundaries',
      body: 'Only outputs may feed another pipeline, and only through a src model. This button counts the edges that break that rule; click it to select the models involved, hover it for the list.',
    },
    {
      target: '.react-flow',
      title: 'Clearing',
      body: (
        <>
          <K>Esc</K> or a click on empty canvas clears the selection.
        </>
      ),
    },
  ],
}

const compare: TourDef = {
  id: 'compare',
  title: 'Pipelines, runs & comparing',
  summary: 'Execution modes, dbt runs, diffing states, exports',
  icon: GitCompare,
  steps: [
    {
      target: ['.pipeline-picker', '.pipeline-picker > .pipeline-picker__menu'],
      enter: async () => {
        await showComparison(false)
        showPanels({ pipelines: true })
      },
      title: 'Pipelines',
      body: 'Choose which pipelines are loaded (none ticked means all). Pipelines with execution modes get mode chips: tick several to stack them on the canvas, the starred one is in front. Pipelines with a project directory can rerun dbt docs generate (the ↻ button).',
    },
    {
      target: ['.task-indicator', '.task-panel'],
      enter: async () => {
        await showComparison(false)
        showPanels({ tasks: true })
      },
      title: 'Background runs',
      body: 'dbt docs generate runs show up here. The chip spins while one runs; the panel shows the live dbt output of a running job and the error of a failed one, with a retry. The graph redraws when fresh artifacts land.',
    },
    {
      target: '[data-tour="compare"]',
      enter: async () => {
        await showComparison(false)
        showPanels()
      },
      title: 'Compare two states',
      body: 'See what a branch changes before it is merged: compare the running state with the artifacts of another one.',
    },
    {
      target: '.modal',
      enter: async () => {
        await showComparison(false)
        showPanels({ dialog: true })
      },
      title: 'Upload artifacts',
      body: 'Drop the manifest.json (and optionally catalog.json, for column changes) from dbt docs generate on your branch, and choose the pipeline they replace.',
    },
    {
      target: ['.react-flow', '.legend'],
      enter: async () => {
        await showComparison(true)
        showPanels()
        if (store().activeId) store().closeOverlay()
      },
      title: 'Reading a comparison',
      body: 'Here a branch is compared: models turn green (added), yellow (modified) or red (removed), and so do the edges. The legend adds the change colours while comparing.',
    },
    {
      target: '.compare-bar',
      enter: async () => {
        await showComparison(true)
        showPanels()
        if (store().activeId) store().closeOverlay()
      },
      title: 'The summary bar',
      body: 'Counts the changes per kind. Select changes selects every changed model, so focus mode shows what they affect; × ends the comparison.',
    },
    {
      target: '.overlay',
      enter: async () => {
        await showComparison(true)
        showPanels()
        await store().openModel(MOCK_COMPARE_MODIFIED_ID, { tab: 'changes' })
      },
      title: 'What changed',
      body: 'A changed model opens on its Changes tab: changed properties and columns, and the SQL diff between the running state and the branch.',
    },
    {
      target: ['.export', '.export__menu'],
      enter: async () => {
        await showComparison(true)
        if (store().activeId) store().closeOverlay()
        showPanels({ export: true })
      },
      title: 'Export',
      body: 'Take the view to a wiki or ticket: PNG or SVG image, or a Mermaid flowchart as a file or ready for Markdown. Exports follow what is shown: filters, focus isolate and comparison colours apply.',
    },
  ],
}

export const TOURS: TourDef[] = [basics, canvas, model, columns, select, compare]

export const tourById = (id: string) => TOURS.find((t) => t.id === id)
