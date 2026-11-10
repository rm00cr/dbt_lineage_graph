/**
 * Background tasks (backend `dbt docs generate` runs) in the top bar: a chip that spins while
 * a job runs and shows a red dot after a failure, a panel with running and recent jobs (live
 * dbt output, errors, retry), and short notices when a job finishes.
 */

import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { GenerationJob } from '../api/types'
import { isActive, jobLabel, type JobNotice, useExplorerStore } from '../store/useExplorerStore'

const NOTICE_MS = { done: 6000, failed: 15000 }
const TRIGGER_LABEL: Record<GenerationJob['trigger'], string> = {
  startup: 'at startup',
  user: 'on demand',
  'mode-switch': 'for mode switch',
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

function jobTime(job: GenerationJob, now: number): string {
  const started = Date.parse(job.started_at)
  if (job.status === 'queued') return 'waiting'
  if (job.status === 'running') return formatDuration(now - started)
  const finished = job.finished_at ? Date.parse(job.finished_at) : now
  return `took ${formatDuration(finished - started)}`
}

function StatusIcon({ job }: { job: GenerationJob }) {
  if (isActive(job)) return <Loader2 size={13} className="spin task__icon task__icon--running" />
  if (job.status === 'failed') return <AlertTriangle size={13} className="task__icon task__icon--failed" />
  return <CheckCircle2 size={13} className="task__icon task__icon--done" />
}

function JobRow({ job, now }: { job: GenerationJob; now: number }) {
  const regenerate = useExplorerStore((s) => s.regenerate)
  const anotherRunning = useExplorerStore((s) =>
    s.jobs.some((j) => isActive(j) && j.pipeline === job.pipeline && j.mode === job.mode),
  )
  const tail = job.log_tail.filter((line) => line.trim())

  return (
    <li className={`task task--${job.status}`}>
      <div className="task__head">
        <StatusIcon job={job} />
        <span className="task__name">{jobLabel(job)}</span>
        <span className="task__meta">
          {job.status} · {TRIGGER_LABEL[job.trigger]} · {jobTime(job, now)}
        </span>
      </div>

      {isActive(job) && tail.length > 0 && (
        <pre className="task__log" aria-label="latest dbt output">
          {tail.slice(-5).join('\n')}
        </pre>
      )}

      {job.status === 'failed' && (
        <>
          {job.error && <div className="task__error">{job.error}</div>}
          <div className="task__actions">
            <details className="task__details">
              <summary>dbt output</summary>
              <pre className="task__log task__log--full">{job.log_tail.join('\n') || '(no output)'}</pre>
            </details>
            <button
              type="button"
              className="pipeline-picker__link"
              disabled={anotherRunning}
              onClick={() => void regenerate(job.pipeline, job.mode)}
            >
              <RotateCcw size={11} /> Retry
            </button>
          </div>
        </>
      )}
    </li>
  )
}

function Notice({ notice }: { notice: JobNotice }) {
  const dismiss = useExplorerStore((s) => s.dismissNotice)
  const setTasksOpen = useExplorerStore((s) => s.setTasksOpen)

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(notice.id), NOTICE_MS[notice.status])
    return () => window.clearTimeout(timer)
  }, [notice.id, notice.status, dismiss])

  return (
    <div className={`task-notice task-notice--${notice.status}`}>
      {notice.status === 'done' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      <span>{notice.text}</span>
      {notice.status === 'failed' && (
        <button
          type="button"
          className="task-notice__link"
          onClick={() => {
            setTasksOpen(true)
            dismiss(notice.id)
          }}
        >
          details
        </button>
      )}
      <button type="button" className="task-notice__close" onClick={() => dismiss(notice.id)} aria-label="dismiss">
        <X size={12} />
      </button>
    </div>
  )
}

function Notices() {
  const notices = useExplorerStore((s) => s.jobNotices)
  if (notices.length === 0) return null
  return (
    <div className="task-notices" role="status">
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} />
      ))}
    </div>
  )
}

export function TaskIndicator() {
  const jobs = useExplorerStore((s) => s.jobs)
  const unseen = useExplorerStore((s) => s.unseenFailures.length)
  const open = useExplorerStore((s) => s.tasksOpen)
  const setOpen = useExplorerStore((s) => s.setTasksOpen)
  const modeError = useExplorerStore((s) => s.modeError)
  const rootRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())

  const running = jobs.filter(isActive).length

  // tick the elapsed times while something runs and the panel is open
  useEffect(() => {
    if (!open || running === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open, running])

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  if (jobs.length === 0) return <Notices />

  const label = running > 0 ? 'running' : unseen > 0 ? 'failed' : 'tasks'
  const title =
    running > 0
      ? `${running} dbt ${running === 1 ? 'task' : 'tasks'} running`
      : unseen > 0
        ? 'A dbt task failed'
        : 'Background dbt tasks'

  return (
    <div className="task-indicator" ref={rootRef}>
      <button
        type="button"
        className={`stat-chip stat-chip--button ${open ? 'stat-chip--open' : ''} ${unseen > 0 && running === 0 ? 'task-indicator--failed' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
        title={title}
      >
        <span className="stat-chip__value task-indicator__value">
          {running > 0 ? (
            <>
              <Loader2 size={13} className="spin" aria-label="running" />
              {running}
            </>
          ) : unseen > 0 ? (
            <AlertTriangle size={14} aria-label="failed" />
          ) : (
            <CheckCircle2 size={14} aria-label="all done" />
          )}
          {unseen > 0 && <span className="task-indicator__dot" />}
        </span>
        <span className="stat-chip__label">
          {label} <ChevronDown size={10} className="stat-chip__caret" />
        </span>
      </button>

      {open && (
        <div className="pipeline-picker__menu task-panel" role="dialog" aria-label="Background tasks">
          <div className="pipeline-picker__head">
            <span>Background tasks · dbt docs generate</span>
          </div>
          {modeError && <div className="pipeline-picker__error">{modeError}</div>}
          <ul className="task-list">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} now={now} />
            ))}
          </ul>
        </div>
      )}
      <Notices />
    </div>
  )
}
