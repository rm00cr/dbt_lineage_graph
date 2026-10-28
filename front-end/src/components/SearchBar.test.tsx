/**
 * @vitest-environment jsdom
 *
 * Covers the AP-3 search path: fuzzy matching, keyboard navigation and the hand-off to the
 * shared store (which is what opens the overlay and centres the graph).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockGraph } from '../api/mock'
import { buildIndex } from '../graph/selectors'
import { useExplorerStore } from '../store/useExplorerStore'
import { SearchBar } from './SearchBar'

function primeStore() {
  useExplorerStore.setState({
    status: 'ready',
    graph: mockGraph,
    index: buildIndex(mockGraph.nodes, mockGraph.edges),
    usingMock: false,
    selectedIds: new Set(),
    activeId: null,
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SearchBar', () => {
  it('finds a model despite a typo and opens it on Enter', async () => {
    primeStore()
    const openModel = vi.fn().mockResolvedValue(undefined)
    useExplorerStore.setState({ openModel })

    const user = userEvent.setup()
    render(<SearchBar />)

    await user.type(screen.getByPlaceholderText(/search models/i), 'contrcts')

    await waitFor(() => expect(screen.getByText('src_mfp_contracts')).toBeDefined())
    expect(screen.getByText(/to navigate/i)).toBeDefined()

    await user.keyboard('{Enter}')

    expect(openModel).toHaveBeenCalledTimes(1)
    expect(openModel.mock.calls[0][0]).toContain('contracts')
    expect(useExplorerStore.getState().selectedIds.size).toBe(1)
  })

  it('moves the cursor with the arrow keys', async () => {
    primeStore()
    const openModel = vi.fn().mockResolvedValue(undefined)
    useExplorerStore.setState({ openModel })

    const user = userEvent.setup()
    render(<SearchBar />)

    await user.type(screen.getByPlaceholderText(/search models/i), 'mfp')
    await waitFor(() => expect(screen.getAllByRole('button', { name: /mfp/i }).length).toBeGreaterThan(1))

    await user.keyboard('{ArrowDown}{Enter}')

    const firstPickedId = openModel.mock.calls[0][0] as string
    expect(firstPickedId).toMatch(/mfp/)
  })

  it('reports no match for nonsense', async () => {
    primeStore()
    const user = userEvent.setup()
    render(<SearchBar />)

    await user.type(screen.getByPlaceholderText(/search models/i), 'zzzzzzzz')
    await waitFor(() => expect(screen.getByText(/no match for/i)).toBeDefined())
  })

  it('tells the user that column search needs the API while on mock data', async () => {
    primeStore()
    useExplorerStore.setState({ usingMock: true })

    const user = userEvent.setup()
    render(<SearchBar />)

    await user.click(screen.getByRole('button', { name: /columns/i }))
    await user.type(screen.getByPlaceholderText(/search columns/i), 'premium')

    await waitFor(() => expect(screen.getByText(/column search needs the API/i)).toBeDefined())
  })

  it('queries the API for columns and shows the column name', async () => {
    primeStore()
    const openModel = vi.fn().mockResolvedValue(undefined)
    useExplorerStore.setState({ openModel })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          query: 'premium',
          results: [
            {
              id: 'model.pnc_analytics.out_mfp_premium_report',
              name: 'out_mfp_premium_report',
              stage: 'out',
              materialization: 'table',
              pipeline: 'bestand_mfp',
              resource_type: 'model',
              score: 0.97,
              matched_on: 'column',
              column: { name: 'annual_premium_chf', type: 'NUMERIC', description: null, index: 4 },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const user = userEvent.setup()
    render(<SearchBar />)

    await user.click(screen.getByRole('button', { name: /columns/i }))
    await user.type(screen.getByPlaceholderText(/search columns/i), 'premium')

    await waitFor(() => expect(screen.getByText('annual_premium_chf')).toBeDefined())
    expect(screen.getByText('out_mfp_premium_report')).toBeDefined()

    const requested = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL
    expect(requested.pathname).toBe('/api/search/columns')
    expect(requested.searchParams.get('q')).toBe('premium')
  })
})
