/**
 * @vitest-environment jsdom
 *
 * Guided tours: stepping through, leaving the app as it was found, remembering finished
 * tours, and placing the card next to its target.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api/client'
import { MOCK_COMPARE_MODIFIED_ID, mockGraph } from '../api/mock'
import { buildIndex } from '../graph/selectors'
import { useExplorerStore } from '../store/useExplorerStore'
import { TOURS, demoModel, tourById } from '../tour/tours'
import { useTourStore } from '../tour/useTourStore'
import { ReactFlowProvider } from '@xyflow/react'

import { TraceBar } from './ColumnTrace'
import { CompareDialog } from './Compare'
import { ExportMenu } from './ExportMenu'
import { HelpMenu } from './HelpMenu'
import { Legend } from './Legend'
import { ModelOverlay } from './ModelOverlay'
import { PipelinePicker } from './PipelinePicker'
import { TaskIndicator } from './TaskIndicator'
import { Toolbar } from './Toolbar'
import { Tour, placeCard, runEnter, unionRect } from './Tour'

function primeStore() {
  useExplorerStore.setState({
    status: 'ready',
    graph: mockGraph,
    index: buildIndex(mockGraph.nodes, mockGraph.edges),
    usingMock: true,
    selectedIds: new Set(),
    selectorInput: '',
    activeId: null,
    columnTrace: null,
    layoutMode: 'dag',
    focusMode: 'off',
    compareDialogOpen: false,
    showMiniMap: true,
    detail: null,
    detailLoading: false,
    detailError: null,
  })
}

const heading = () => screen.getByRole('heading').textContent

beforeEach(() => {
  window.localStorage.clear()
  primeStore()
  useTourStore.setState({ tourId: null, steps: [], index: 0, menuOpen: false, completed: new Set() })
})

afterEach(() => {
  act(() => useTourStore.getState().close())
  cleanup()
  vi.restoreAllMocks()
})

describe('tour content', () => {
  it('has unique ids and only suggests tours that exist', () => {
    expect(new Set(TOURS.map((t) => t.id)).size).toBe(TOURS.length)
    for (const tour of TOURS) {
      expect(tour.steps.length).toBeGreaterThan(0)
      if (tour.next) expect(tourById(tour.next)).toBeDefined()
    }
  })

  it('only uses valid CSS selectors', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (!step.target || typeof step.target === 'function') continue
        for (const selector of [step.target].flat()) {
          expect(() => document.querySelector(selector), `${tour.id}: ${step.title}`).not.toThrow()
        }
      }
    }
  })

  it('demonstrates on a connected model, or the one that is open', () => {
    const { index } = useExplorerStore.getState()
    const demo = demoModel()!
    expect(demo.resource_type).toBe('model')
    expect(index.parents.get(demo.id)?.length).toBeGreaterThan(0)
    expect(index.children.get(demo.id)?.length).toBeGreaterThan(0)

    const other = mockGraph.nodes.find((n) => n.resource_type === 'model' && n.id !== demo.id)!
    useExplorerStore.setState({ activeId: other.id })
    expect(demoModel()?.id).toBe(other.id)
  })
})

describe('Tour', () => {
  it('renders nothing without a running tour', () => {
    const { container } = render(<Tour />)
    expect(container.innerHTML).toBe('')
  })

  it('steps forward and back, and falls back to a centred card without a target', () => {
    render(<Tour />)
    act(() => useTourStore.getState().start('basics'))
    const steps = useTourStore.getState().steps
    expect(heading()).toBe(steps[0].title)
    expect((screen.getByRole('button', { name: /back/i }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(heading()).toBe(steps[1].title)
    // jsdom lays nothing out, so no target is ever "on screen"
    expect(document.querySelector('.tour__spotlight')).toBeNull()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(heading()).toBe(steps[0].title)
  })

  it('keeps the canvas shortcuts quiet and closes on Escape', () => {
    const canvasKeys = vi.fn()
    window.addEventListener('keydown', canvasKeys)
    render(<Tour />)
    act(() => useTourStore.getState().start('basics'))

    fireEvent.keyDown(window, { key: 'f' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(canvasKeys).not.toHaveBeenCalled()
    expect(useTourStore.getState().tourId).toBeNull()
    window.removeEventListener('keydown', canvasKeys)
  })

  it('offers the next tour at the end and marks the finished one done', () => {
    render(<Tour />)
    act(() => useTourStore.getState().start('basics'))
    const count = useTourStore.getState().steps.length
    for (let i = 1; i < count; i++) fireEvent.keyDown(window, { key: 'ArrowRight' })

    fireEvent.click(screen.getByRole('button', { name: /next: navigating the canvas/i }))
    expect(useTourStore.getState().completed.has('basics')).toBe(true)
    expect(useTourStore.getState().tourId).toBe('canvas')
    expect(JSON.parse(window.localStorage.getItem('lineage-explorer.tours')!)).toEqual(['basics'])
  })

  it('does not mark a tour done when it is skipped', () => {
    render(<Tour />)
    act(() => useTourStore.getState().start('basics'))
    fireEvent.click(screen.getByRole('button', { name: /skip/i }))
    expect(useTourStore.getState().completed.size).toBe(0)
  })
})

describe('useTourStore', () => {
  it('puts the explorer back the way it was after a tour drove it', async () => {
    useTourStore.getState().start('canvas')
    // the focus steps select the demo model and isolate it
    const focusStep = useTourStore.getState().steps.findIndex((s) => s.title === 'Focus: isolate')
    useExplorerStore.getState().setLayoutMode('lanes')
    await useTourStore.getState().steps[focusStep].enter?.()

    expect(useExplorerStore.getState().focusMode).toBe('isolate')
    expect(useExplorerStore.getState().selectedIds.size).toBe(1)

    useTourStore.getState().close()
    const after = useExplorerStore.getState()
    expect(after.focusMode).toBe('off')
    expect(after.layoutMode).toBe('dag')
    expect(after.selectedIds.size).toBe(0)
  })

  it('opens and closes the model panel around the model tour', async () => {
    useTourStore.getState().start('model')
    await useTourStore.getState().steps[3].enter?.()
    expect(useExplorerStore.getState().activeId).toBe(demoModel()!.id)
    expect(useExplorerStore.getState().overlayTab).toBe('code')

    useTourStore.getState().close()
    expect(useExplorerStore.getState().activeId).toBeNull()
  })

  it('shows the mini-map for its step and hides it again afterwards', async () => {
    useExplorerStore.setState({ showMiniMap: false })
    useTourStore.getState().start('canvas')
    await useTourStore.getState().steps.find((s) => s.title === 'Mini-map')!.enter?.()
    expect(useExplorerStore.getState().showMiniMap).toBe(true)
    expect(useExplorerStore.getState().focusMode).toBe('off')

    useTourStore.getState().close()
    expect(useExplorerStore.getState().showMiniMap).toBe(false)
  })

  it('traces a column even when the model detail is still loading', async () => {
    useTourStore.getState().start('columns')
    const steps = useTourStore.getState().steps
    const demo = demoModel()!
    // the previous step opened the model; its detail has not arrived yet
    useExplorerStore.setState({ activeId: demo.id, overlayTab: 'schema', detail: null, detailLoading: true })
    const entering = steps.find((s) => s.title === 'The trace')!.enter?.()

    await useExplorerStore.getState().openModel(demo.id, { tab: 'schema' }) // mock: detail lands now
    await entering
    expect(useExplorerStore.getState().columnTrace?.modelId).toBe(demo.id)

    // stepping back to the schema step drops the trace again
    await steps.find((s) => s.title === 'Trace from the schema')!.enter?.()
    expect(useExplorerStore.getState().columnTrace).toBeNull()
  })

  it('undoes the applied selection when stepping back to the selector step', () => {
    useTourStore.getState().start('select')
    const [type, apply] = useTourStore.getState().steps
    apply.enter?.()
    expect(useExplorerStore.getState().selectedIds.size).toBeGreaterThan(0)

    type.enter?.()
    expect(useExplorerStore.getState().selectedIds.size).toBe(0)
    expect(useExplorerStore.getState().selectorInput).toBe(`+${demoModel()!.name}+`)
  })

  it('runs on the demo project and gives the loaded project back untouched', () => {
    const real = { ...mockGraph, nodes: mockGraph.nodes.map((n) => ({ ...n, folder: null })) }
    useExplorerStore.setState({ graph: real, usingMock: false, meta: null, jobs: [], selectorInput: 'tag:x' })

    useTourStore.getState().start('compare')
    const demo = useExplorerStore.getState()
    expect(demo.demo).toBe(true)
    expect(demo.graph).not.toBe(real)
    expect(demo.jobs.length).toBeGreaterThan(0)
    expect(demo.pipelineInfo.some((p) => p.modes.length > 1)).toBe(true)

    useTourStore.getState().close()
    const after = useExplorerStore.getState()
    expect(after.demo).toBe(false)
    expect(after.graph).toBe(real)
    expect(after.usingMock).toBe(false)
    expect(after.jobs).toEqual([])
    expect(after.selectorInput).toBe('tag:x')
  })

  it('keeps every step on the demo project, whatever is loaded', () => {
    // a real project without folders or boundary violations
    useExplorerStore.setState({
      graph: { ...mockGraph, nodes: mockGraph.nodes.map((n) => ({ ...n, folder: null })), edges: [] },
    })
    for (const tour of TOURS) {
      useTourStore.getState().start(tour.id)
      expect(useTourStore.getState().steps.map((s) => s.title), tour.id).toEqual(tour.steps.map((s) => s.title))
      useTourStore.getState().close()
    }
  })

  it('opens the panels a step talks about and closes the others', async () => {
    useTourStore.getState().start('compare')
    const step = (title: string) => useTourStore.getState().steps.find((s) => s.title === title)!

    await step('Pipelines').enter?.()
    expect(useExplorerStore.getState().pipelinesOpen).toBe(true)

    await step('Background runs').enter?.()
    expect(useExplorerStore.getState().pipelinesOpen).toBe(false)
    expect(useExplorerStore.getState().tasksOpen).toBe(true)

    await step('Export').enter?.()
    expect(useExplorerStore.getState().tasksOpen).toBe(false)
    expect(useExplorerStore.getState().exportOpen).toBe(true)

    useTourStore.getState().close()
    expect(useExplorerStore.getState().exportOpen).toBe(false)
  })

  it('shows a comparison on the demo project and ends it when stepping back', async () => {
    const graphCall = vi.spyOn(api, 'graph')
    useTourStore.getState().start('compare')
    const step = (title: string) => useTourStore.getState().steps.find((s) => s.title === title)!

    await step('What changed').enter?.()
    let s = useExplorerStore.getState()
    expect(s.compare?.response.summary).toMatchObject({ added: 1, modified: 1, removed: 1 })
    expect(s.graph?.nodes.some((n) => n.change === 'added')).toBe(true)
    expect(s.activeId).toBe(MOCK_COMPARE_MODIFIED_ID)
    expect(s.overlayTab).toBe('changes')

    await step('Compare two states').enter?.()
    s = useExplorerStore.getState()
    expect(s.compare).toBeNull()
    expect(s.graph?.nodes.some((n) => n.change)).toBe(false)
    expect(graphCall).not.toHaveBeenCalled() // the demo never asks the API

    await step('Reading a comparison').enter?.()
    useTourStore.getState().close()
    expect(useExplorerStore.getState().compare).toBeNull()
  })

  it('opens the filter row for its step only', () => {
    useTourStore.getState().start('canvas')
    const step = (title: string) => useTourStore.getState().steps.find((s) => s.title === title)!
    step('Filters').enter?.()
    expect(useExplorerStore.getState().filtersOpen).toBe(true)
    step('Keyboard shortcuts').enter?.()
    expect(useExplorerStore.getState().filtersOpen).toBe(false)
  })
})

describe('HelpMenu', () => {
  it('lists the tours and starts one', () => {
    render(<HelpMenu />)
    fireEvent.click(screen.getByRole('button', { name: /help/i }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(TOURS.length)

    fireEvent.click(screen.getByRole('menuitem', { name: /inspecting a model/i }))
    expect(useTourStore.getState().tourId).toBe('model')
    expect(useTourStore.getState().menuOpen).toBe(false)
  })
})

describe('every tour step', () => {
  it('renders the panels it drives without crashing', async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    render(
      <ReactFlowProvider>
        <Toolbar onToast={() => undefined} />
        <Legend />
        <ModelOverlay onToast={() => undefined} />
        <TraceBar />
        <PipelinePicker />
        <TaskIndicator />
        <ExportMenu onToast={() => undefined} />
        <CompareDialog />
      </ReactFlowProvider>,
    )
    for (const tour of TOURS) {
      act(() => useTourStore.getState().start(tour.id))
      for (const step of useTourStore.getState().steps) {
        // a render loop or a throw in any panel fails here (it blanked the app in the model tour)
        await act(async () => {
          await step.enter?.()
        })
      }
      act(() => useTourStore.getState().close())
    }
  })
})

describe('runEnter', () => {
  it('runs the enters in order and skips a step the user already left', async () => {
    const log: string[] = []
    let release!: () => void
    const slow = new Promise<void>((resolve) => (release = resolve))
    const first = runEnter({ title: 'a', body: '', enter: async () => { await slow; log.push('a') } }, () => true)
    let bCurrent = true
    const second = runEnter({ title: 'b', body: '', enter: () => void log.push('b') }, () => bCurrent)
    const third = runEnter({ title: 'c', body: '', enter: () => void log.push('c') }, () => true)
    bCurrent = false
    release()
    await Promise.all([first, second, third])
    expect(log).toEqual(['a', 'c'])
  })
})

describe('unionRect', () => {
  it('spans all boxes', () => {
    expect(
      unionRect([
        { top: 10, left: 50, right: 100, bottom: 40 },
        { top: 30, left: 20, right: 90, bottom: 200 },
      ]),
    ).toEqual({ top: 10, left: 20, right: 100, bottom: 200 })
    expect(unionRect([])).toBeNull()
  })
})

describe('placeCard', () => {
  const vw = 1200
  const vh = 800

  it('centres the card without a target', () => {
    expect(placeCard(null, 360, 200, vw, vh)).toEqual({ top: 300, left: 420 })
  })

  it('prefers below, then above, then beside the target', () => {
    expect(placeCard({ top: 50, left: 100, width: 200, height: 40 }, 360, 200, vw, vh).top).toBe(102)
    expect(placeCard({ top: 700, left: 100, width: 200, height: 40 }, 360, 200, vw, vh).top).toBe(488)
    // a tall panel on the right: the card goes to its left
    const beside = placeCard({ top: 60, left: 800, width: 400, height: 740 }, 360, 200, vw, vh)
    expect(beside.left).toBe(800 - 12 - 360)
  })

  it('stays inside the viewport for a full-screen target', () => {
    const pos = placeCard({ top: 2, left: 2, width: 1196, height: 796 }, 360, 200, vw, vh)
    expect(pos.top + 200).toBeLessThanOrEqual(vh - 16)
    expect(pos.left).toBeGreaterThanOrEqual(16)
  })
})
