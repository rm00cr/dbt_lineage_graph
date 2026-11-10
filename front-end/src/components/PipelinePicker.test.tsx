/**
 * @vitest-environment jsdom
 *
 * Execution modes in the pipeline picker: only pipelines with modes get the dropdown, it shows
 * the active mode, and picking another one goes through the store.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GenerationJob, MetaResponse, PipelineInfo } from '../api/types'
import { useExplorerStore } from '../store/useExplorerStore'
import { PipelinePicker } from './PipelinePicker'

const PIPELINES: PipelineInfo[] = [
  {
    name: 'bestand_mfp',
    active_mode: 'full',
    available: true,
    generated_at: '2026-11-01T00:00:00Z',
    modes: [
      { name: 'full', vars: { full_mode: true }, available: true, generated_at: null, manifest: 'f/manifest.json' },
      { name: 'incremental', vars: { full_mode: false }, available: true, generated_at: null, manifest: 'i/manifest.json' },
      { name: 'monthly', vars: { monthly_mode: true }, available: false, generated_at: null, manifest: 'm/manifest.json' },
    ],
  },
  { name: 'schaden_claims', active_mode: null, available: true, generated_at: null, modes: [] },
]

function prime(setPipelineMode = vi.fn().mockResolvedValue(undefined)) {
  useExplorerStore.setState({
    meta: { pipelines: ['bestand_mfp', 'schaden_claims'] } as MetaResponse,
    pipelineInfo: PIPELINES,
    modeSwitching: null,
    modeError: null,
    jobs: [],
    setPipelineMode,
  })
  return setPipelineMode
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PipelinePicker execution modes', () => {
  it('shows a mode dropdown only for pipelines with modes', async () => {
    prime()
    const user = userEvent.setup()
    render(<PipelinePicker />)
    await user.click(screen.getByTitle(/choose which pipelines/i))

    const select = screen.getByLabelText('Execution mode of bestand_mfp') as HTMLSelectElement
    expect(select.value).toBe('full')
    expect(screen.queryByLabelText('Execution mode of schaden_claims')).toBeNull()

    const monthly = screen.getByRole('option', { name: /monthly · not available/ }) as HTMLOptionElement
    expect(monthly.disabled).toBe(true)
  })

  it('switches the mode through the store', async () => {
    const setPipelineMode = prime()
    const user = userEvent.setup()
    render(<PipelinePicker />)
    await user.click(screen.getByTitle(/choose which pipelines/i))

    await user.selectOptions(screen.getByLabelText('Execution mode of bestand_mfp'), 'incremental')
    expect(setPipelineMode).toHaveBeenCalledWith('bestand_mfp', 'incremental')
  })

  it('offers generation for missing modes and regenerates the shown one', async () => {
    prime()
    const regenerate = vi.fn().mockResolvedValue(undefined)
    const running: GenerationJob = {
      id: 'j1',
      pipeline: 'bestand_mfp',
      mode: 'incremental',
      trigger: 'user',
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      command: 'dbt docs generate',
      log_tail: [],
    }
    useExplorerStore.setState({
      regenerate,
      jobs: [running],
      pipelineInfo: [{ ...PIPELINES[0], can_generate: true, pending_mode: 'incremental' }, PIPELINES[1]],
    })
    const user = userEvent.setup()
    render(<PipelinePicker />)
    await user.click(screen.getByTitle(/choose which pipelines/i))

    const monthly = screen.getByRole('option', { name: /monthly · not generated/ }) as HTMLOptionElement
    expect(monthly.disabled).toBe(false)
    expect(screen.getByRole('option', { name: /incremental · generating…/ })).toBeDefined()
    expect(screen.getByLabelText('generating incremental')).toBeDefined()

    await user.click(screen.getByLabelText('Regenerate bestand_mfp (full)'))
    expect(regenerate).toHaveBeenCalledWith('bestand_mfp', 'full')
    // schaden_claims has no project_dir
    expect(screen.queryByLabelText(/Regenerate schaden_claims/)).toBeNull()
  })

  it('shows a failed switch', async () => {
    prime()
    useExplorerStore.setState({ modeError: "execution mode 'monthly' of 'bestand_mfp' has no artifacts yet" })
    const user = userEvent.setup()
    render(<PipelinePicker />)
    await user.click(screen.getByTitle(/choose which pipelines/i))
    expect(screen.getByText(/has no artifacts yet/)).toBeDefined()
  })
})
