/**
 * @vitest-environment jsdom
 *
 * Background dbt runs in the top bar: hidden without jobs, spinner + live output while one
 * runs, error + retry for a failed one, and the store turning finished jobs into notices.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api/client'
import type { GenerationJob, PipelineInfo } from '../api/types'
import { useExplorerStore } from '../store/useExplorerStore'
import { formatDuration, TaskIndicator } from './TaskIndicator'

function job(patch: Partial<GenerationJob>): GenerationJob {
  return {
    id: 'j1',
    pipeline: 'bestand_mfp',
    mode: 'incremental',
    trigger: 'user',
    status: 'running',
    started_at: new Date(Date.now() - 5000).toISOString(),
    finished_at: null,
    error: null,
    command: 'dbt docs generate',
    log_tail: ['Running with dbt=1.8.7', 'Found 23 models'],
    ...patch,
  }
}

function prime(jobs: GenerationJob[], extra: Partial<ReturnType<typeof useExplorerStore.getState>> = {}) {
  useExplorerStore.setState({
    jobs,
    jobsLoaded: true,
    jobNotices: [],
    unseenFailures: [],
    tasksOpen: false,
    modeError: null,
    usingMock: false,
    compare: null,
    ...extra,
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TaskIndicator', () => {
  it('is hidden while there are no jobs', () => {
    prime([])
    const { container } = render(<TaskIndicator />)
    expect(container.innerHTML).toBe('')
  })

  it('shows a running job with its live dbt output', async () => {
    prime([job({})])
    const user = userEvent.setup()
    render(<TaskIndicator />)

    const chip = screen.getByTitle('1 dbt task running')
    expect(chip.textContent).toContain('running')
    await user.click(chip)
    expect(screen.getByText('bestand_mfp · incremental')).toBeDefined()
    expect(screen.getByLabelText('latest dbt output').textContent).toContain('Found 23 models')
  })

  it('flags a failure until the panel is opened, and retries it', async () => {
    const regenerate = vi.fn().mockResolvedValue(undefined)
    const failed = job({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: 'dbt docs generate exited with code 1: Database Error',
      log_tail: ['Database Error: could not connect'],
    })
    prime([failed], { unseenFailures: ['j1'], regenerate })
    const user = userEvent.setup()
    render(<TaskIndicator />)

    await user.click(screen.getByTitle('A dbt task failed'))
    expect(useExplorerStore.getState().unseenFailures).toEqual([])
    expect(screen.getByText(/exited with code 1/)).toBeDefined()

    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(regenerate).toHaveBeenCalledWith('bestand_mfp', 'incremental')
  })

  it('formats durations', () => {
    expect(formatDuration(4200)).toBe('4s')
    expect(formatDuration(125_000)).toBe('2m 05s')
  })
})

describe('pollJobs', () => {
  const info: PipelineInfo[] = [
    { name: 'bestand_mfp', active_mode: 'incremental', available: true, generated_at: null, modes: [] },
  ]

  it('turns finished jobs into notices and redraws when the shown mode changed', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    prime([job({})], { refresh, activeId: null })
    vi.spyOn(api, 'jobs').mockResolvedValue([job({ status: 'done', finished_at: new Date().toISOString() })])
    vi.spyOn(api, 'pipelines').mockResolvedValue(info)

    await useExplorerStore.getState().pollJobs()

    expect(refresh).toHaveBeenCalledTimes(1)
    const [notice] = useExplorerStore.getState().jobNotices
    expect(notice).toMatchObject({ id: 'j1', status: 'done' })
    expect(notice.text).toContain('graph updated')
    expect(useExplorerStore.getState().pipelineInfo).toEqual(info)
  })

  it('records a failure without redrawing', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    prime([job({})], { refresh })
    vi.spyOn(api, 'jobs').mockResolvedValue([job({ status: 'failed', error: 'boom' })])
    vi.spyOn(api, 'pipelines').mockResolvedValue(info)

    await useExplorerStore.getState().pollJobs()

    expect(refresh).not.toHaveBeenCalled()
    expect(useExplorerStore.getState().unseenFailures).toEqual(['j1'])
    expect(useExplorerStore.getState().jobNotices[0].status).toBe('failed')
  })

  it('treats jobs finished before the first poll as history', async () => {
    prime([], { jobsLoaded: false })
    vi.spyOn(api, 'jobs').mockResolvedValue([job({ status: 'done' })])
    const pipelines = vi.spyOn(api, 'pipelines')

    await useExplorerStore.getState().pollJobs()

    expect(useExplorerStore.getState().jobNotices).toEqual([])
    expect(pipelines).not.toHaveBeenCalled()
  })
})
