/**
 * Content of the guided tours (started from the Help menu, see useTourStore).
 *
 * A step spotlights `target` (a CSS selector, or a function returning one) and explains it.
 * `enter` runs whenever the step is shown, forward or back, and puts the app in the state the
 * step talks about, so it must be idempotent. `when` drops a step that does not apply to the
 * loaded project (no sub-folders, no boundary violations, ...); it is evaluated at start.
 *
 * Targets that are not on screen get a centred card, so a sparse project never breaks a tour.
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

import type { GraphNode } from '../api/types'
import { boundaryViolations } from '../graph/boundary'
import { useExplorerStore } from '../store/useExplorerStore'

export interface TourStep {
  target?: string | (() => string | null)
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

/** the demo model's column with the most column-lineage edges */
async function traceDemoColumn() {
  await openDemo('schema')
  const { detail, columnTrace, traceColumn } = store()
  if (!detail) return
  const best = [...detail.columns]
    .map((c) => ({ name: c.name, edges: (c.upstream_count ?? 0) + (c.downstream_count ?? 0) }))
    .sort((a, b) => b.edges - a.edges)[0]
  if (!best || best.edges === 0) return
  if (columnTrace?.modelId === detail.id && columnTrace.column === best.name) return
  await traceColumn(detail.id, best.name, 'both')
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
      enter: () => store().setLayoutMode('dag'),
      title: 'DAG layout',
      body: (
        <>
          A directed graph, left to right: best to follow one chain of models. <K>L</K> switches layouts.
        </>
      ),
    },
    {
      target: '[data-tour="layout"]',
      enter: () => store().setLayoutMode('lanes'),
      title: 'Zones layout',
      body: 'Stages as columns: sources, intermediate and output models line up, so you see at a glance which layer a model belongs to. With several pipelines shown, each gets its own band.',
    },
    {
      target: '.toolbar__zones',
      when: hasFolders,
      enter: () => {
        store().setLayoutMode('lanes')
        store().setZoneMode('folders')
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
      enter: () => store().setFocusMode('dim'),
      title: 'Mini-map',
      body: (
        <>
          The whole graph in small, with the visible part framed. <K>M</K> shows or hides it.
        </>
      ),
    },
    {
      target: '[data-tour="area-select"]',
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
      target: '[data-tour="filters"]',
      title: 'Filters',
      body: 'Opens a row to load only some pipelines or stages, or to hide dbt sources. The graph reloads with the filtered set. The arrows next to it reload the graph from the API.',
    },
    {
      target: '.shortcut-hint',
      title: 'Keyboard shortcuts',
      body: (
        <>
          <K>/</K> search · <K>F</K> focus · <K>L</K> layout · <K>Z</K> fit · <K>M</K> mini-map ·{' '}
          <K>Esc</K> close / clear · <K>Alt</K>+<K>Z</K> wrap code · <K>?</K> help.
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
      target: '.overlay__actions',
      enter: () => openDemo('overview'),
      title: 'Run it, find it',
      body: 'dbt run copies the command that builds just this model. BigQuery opens the table in the cloud console, when the project knows where it is deployed.',
    },
    {
      target: '.overlay__body',
      enter: () => openDemo('overview'),
      title: 'Overview',
      body: 'Properties, where the table lives (database, schema, dbt file, unique_id) and its lineage at a glance.',
    },
    {
      target: '.overlay__body',
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
      target: '.overlay__body',
      enter: () => openDemo('schema'),
      title: 'Schema',
      body: 'All columns with type and description, filterable. The ↑ ↓ button on each column counts its direct upstream and downstream columns, and clicking it traces the column (see "Column-level lineage").',
    },
    {
      target: '.overlay__body',
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
      enter: () => openDemo('schema'),
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
      target: '.pipeline-picker',
      enter: () => store().setCompareDialogOpen(false),
      title: 'Pipelines',
      body: 'Choose which pipelines are loaded (none ticked means all). Pipelines with execution modes get mode chips: tick several to stack them on the canvas, the starred one is in front. Pipelines with a project directory can rerun dbt docs generate.',
    },
    {
      target: '.task-indicator',
      enter: () => store().setCompareDialogOpen(false),
      title: 'Background runs',
      body: 'dbt docs generate runs show up here: it spins while one runs, opens to the live dbt output and errors, and the graph redraws when fresh artifacts land.',
    },
    {
      target: '[data-tour="compare"]',
      enter: () => store().setCompareDialogOpen(false),
      title: 'Compare two states',
      body: 'See what a branch changes before it is merged: compare the running state with the artifacts of another one.',
    },
    {
      target: '.modal',
      enter: () => store().setCompareDialogOpen(true),
      title: 'Upload artifacts',
      body: 'Drop the manifest.json (and optionally catalog.json, for column changes) from dbt docs generate on your branch, and choose the pipeline they replace.',
    },
    {
      target: '.legend',
      enter: () => store().setCompareDialogOpen(false),
      title: 'Reading a comparison',
      body: 'Models turn green (added), yellow (modified) or red (removed). A summary bar under the toolbar can select all changes, and a changed model opens on a Changes tab with the SQL diff.',
    },
    {
      target: '.export',
      title: 'Export',
      body: 'Take the view to a wiki or ticket: PNG or SVG image, or a Mermaid flowchart as a file or ready for Markdown. Exports follow what is shown: filters, focus isolate and comparison colours apply.',
    },
  ],
}

export const TOURS: TourDef[] = [basics, canvas, model, columns, select, compare]

export const tourById = (id: string) => TOURS.find((t) => t.id === id)
