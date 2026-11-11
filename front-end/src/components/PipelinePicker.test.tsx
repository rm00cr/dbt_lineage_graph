/**
 * @vitest-environment jsdom
 *
 * Execution modes in the pipeline picker: only pipelines with modes get mode chips; ticked
 * modes are stacked, the starred one is in front, and every change goes through the store.
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

function prime(setPipelineModes = vi.fn().mockResolvedValue(undefined), info: PipelineInfo[] = PIPELINES) {
  useExplorerStore.setState({
    meta: { pipelines: ['bestand_mfp', 'schaden_claims'] } as MetaResponse,
    pipelineInfo: info,
    modeSwitching: null,
    modeError: null,
    jobs: [],
    setPipelineModes,
  })
  return setPipelineModes
}

async function openPicker() {
  const user = userEvent.setup()
  render(<PipelinePicker />)
  await user.click(screen.getByTitle(/choose which pipelines/i))
  return user
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PipelinePicker execution modes', () => {
  it('shows mode chips only for pipelines with modes, the shown one ticked and in front', async () => {
    prime()
    await openPicker()

    expect(screen.getByRole('group', { name: 'Execution modes of bestand_mfp' })).toBeDefined()
    expect(screen.queryByRole('group', { name: 'Execution modes of schaden_claims' })).toBeNull()

    expect(screen.getByLabelText('Hide mode full').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('full is in front')).toBeDefined()
    expect(screen.getByLabelText('Show mode incremental').getAttribute('aria-pressed')).toBe('false')
    // not on disk and no project_dir to generate it
    const monthly = screen.getByLabelText('Show mode monthly') as HTMLButtonElement
    expect(monthly.disabled).toBe(true)
    expect(monthly.textContent).toContain('monthly · not available')
  })

  it('stacks modes and brings one to the front through the store', async () => {
    const setPipelineModes = prime()
    const user = await openPicker()

    await user.click(screen.getByLabelText('Show mode incremental'))
    expect(setPipelineModes).toHaveBeenLastCalledWith('bestand_mfp', ['full', 'incremental'], 'full')

    await user.click(screen.getByLabelText('Bring incremental to the front'))
    expect(setPipelineModes).toHaveBeenLastCalledWith('bestand_mfp', ['full', 'incremental'], 'incremental')
  })

  it('hiding the front mode moves the next one to the front, the last mode stays', async () => {
    const setPipelineModes = prime(undefined, [{ ...PIPELINES[0], stacked_modes: ['incremental'] }, PIPELINES[1]])
    const user = await openPicker()

    await user.click(screen.getByLabelText('Hide mode full'))
    expect(setPipelineModes).toHaveBeenLastCalledWith('bestand_mfp', ['incremental'], 'incremental')

    cleanup()
    setPipelineModes.mockClear()
    prime(setPipelineModes)
    const again = await openPicker()
    await again.click(screen.getByLabelText('Hide mode full')) // the only shown mode
    expect(setPipelineModes).not.toHaveBeenCalled()
  })

  it('offers generation for missing modes and regenerates any mode from its chip', async () => {
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
    const user = await openPicker()

    const monthly = screen.getByLabelText('Show mode monthly') as HTMLButtonElement
    expect(monthly.disabled).toBe(false)
    expect(monthly.textContent).toContain('monthly · not generated')
    expect(screen.getByLabelText('Show mode incremental').textContent).toContain('incremental · generating…')
    expect(screen.getByLabelText('generating incremental')).toBeDefined()
    expect(screen.getByLabelText('full is in front')).toBeDefined() // still, until it is done

    // every mode has its own button; no pipeline-level one for a pipeline with modes
    expect(screen.queryByLabelText('Regenerate bestand_mfp')).toBeNull()
    await user.click(screen.getByLabelText('Regenerate bestand_mfp (full)'))
    expect(regenerate).toHaveBeenLastCalledWith('bestand_mfp', 'full')
    // a mode that is not shown
    await user.click(screen.getByLabelText('Generate bestand_mfp (monthly)'))
    expect(regenerate).toHaveBeenLastCalledWith('bestand_mfp', 'monthly')
    // the running one cannot be started twice
    expect((screen.getByLabelText('Regenerate bestand_mfp (incremental)') as HTMLButtonElement).disabled).toBe(true)
    // schaden_claims has no project_dir
    expect(screen.queryByLabelText(/Regenerate schaden_claims/)).toBeNull()
  })

  it('marks the mode whose last run failed in its chip', async () => {
    prime()
    const failed: GenerationJob = {
      id: 'j2',
      pipeline: 'bestand_mfp',
      mode: 'incremental',
      trigger: 'user',
      status: 'failed',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: 'dbt docs generate exited with code 2',
      command: 'dbt docs generate',
      log_tail: [],
    }
    useExplorerStore.setState({
      jobs: [failed],
      pipelineInfo: [{ ...PIPELINES[0], can_generate: true }, PIPELINES[1]],
    })
    await openPicker()

    const marker = screen.getByLabelText('last dbt run of incremental failed')
    expect(marker.getAttribute('title')).toContain('exited with code 2')
    expect(screen.queryByLabelText('last dbt run of full failed')).toBeNull()
    expect((screen.getByLabelText('Regenerate bestand_mfp (incremental)') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the pipeline-level button for a pipeline without modes', async () => {
    prime()
    const regenerate = vi.fn().mockResolvedValue(undefined)
    useExplorerStore.setState({
      regenerate,
      pipelineInfo: [PIPELINES[0], { ...PIPELINES[1], can_generate: true }],
    })
    const user = await openPicker()

    await user.click(screen.getByLabelText('Regenerate schaden_claims'))
    expect(regenerate).toHaveBeenCalledWith('schaden_claims', null)
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
