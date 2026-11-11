/**
 * @vitest-environment jsdom
 *
 * Guided tours: stepping through, leaving the app as it was found, remembering finished
 * tours, and placing the card next to its target.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockGraph } from '../api/mock'
import { buildIndex } from '../graph/selectors'
import { useExplorerStore } from '../store/useExplorerStore'
import { TOURS, demoModel, tourById } from '../tour/tours'
import { useTourStore } from '../tour/useTourStore'
import { HelpMenu } from './HelpMenu'
import { Tour, placeCard } from './Tour'

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

  it('drops steps that do not apply to the project', () => {
    useExplorerStore.setState({
      graph: { ...mockGraph, nodes: mockGraph.nodes.map((n) => ({ ...n, folder: null })) },
    })
    useTourStore.getState().start('canvas')
    expect(useTourStore.getState().steps.some((s) => s.title === 'Groups')).toBe(false)
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
