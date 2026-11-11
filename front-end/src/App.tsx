import { ReactFlowProvider } from '@xyflow/react'
import { GitFork, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { TraceBar } from './components/ColumnTrace'
import { CompareButton, CompareDialog } from './components/Compare'
import { ExportMenu } from './components/ExportMenu'
import { GraphCanvas } from './components/GraphCanvas'
import { Legend } from './components/Legend'
import { ModelOverlay } from './components/ModelOverlay'
import { PipelinePicker } from './components/PipelinePicker'
import { SearchBar } from './components/SearchBar'
import { TaskIndicator } from './components/TaskIndicator'
import { ThemeToggle } from './components/ThemeToggle'
import { HelpMenu } from './components/HelpMenu'
import { Tour } from './components/Tour'
import { Toolbar } from './components/Toolbar'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useUrlSync } from './hooks/useUrlSync'
import { useExplorerStore } from './store/useExplorerStore'
import { useSystemThemeListener } from './theme/useTheme'

export default function App() {
  return (
    <ReactFlowProvider>
      <Explorer />
    </ReactFlowProvider>
  )
}

function Explorer() {
  const status = useExplorerStore((s) => s.status)
  const graph = useExplorerStore((s) => s.graph)
  const meta = useExplorerStore((s) => s.meta)
  const usingMock = useExplorerStore((s) => s.usingMock)
  const errorMessage = useExplorerStore((s) => s.errorMessage)
  const init = useExplorerStore((s) => s.init)

  const [toast, setToast] = useState<string | null>(null)
  useKeyboardShortcuts()
  useUrlSync()
  useSystemThemeListener()

  useEffect(() => {
    void init()
  }, [init])

  // background dbt runs: drives the task indicator and redraws when fresh artifacts land
  const startJobPolling = useExplorerStore((s) => s.startJobPolling)
  useEffect(() => startJobPolling(), [startJobPolling])

  const showToast = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 1800)
  }

  const modelCount = meta?.model_count ?? graph?.nodes.filter((n) => n.resource_type === 'model').length ?? 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">
            <GitFork size={18} strokeWidth={2.4} />
          </span>
          <span className="brand__text">
            <span className="brand__title">dbt Lineage Explorer</span>
            <span className="brand__subtitle">PnC Data Platform</span>
          </span>
        </div>

        <SearchBar />
        <span className="topbar__spacer" />

        <ExportMenu onToast={showToast} />
        <CompareButton />
        <ThemeToggle />
        <HelpMenu />

        <div className="topbar__stats">
          <div className="stat-chip">
            <span className="stat-chip__value">{modelCount}</span>
            <span className="stat-chip__label">models</span>
          </div>
          <div className="stat-chip">
            <span className="stat-chip__value">{graph?.stats.edge_count ?? 0}</span>
            <span className="stat-chip__label">edges</span>
          </div>
          <PipelinePicker />
          <TaskIndicator />
        </div>
      </header>

      <div className="app__body">
        {status === 'loading' ? (
          <div className="loading">
            <div>
              <div className="spinner" />
              Loading lineage graph…
            </div>
          </div>
        ) : (
          <>
            <GraphCanvas />
            <Toolbar onToast={showToast} />
            <Legend />
            <ModelOverlay onToast={showToast} />
            <TraceBar />

            {usingMock && (
              <div className="banner" title={errorMessage ?? undefined}>
                <TriangleAlert size={14} />
                Mock data — API not reachable. Start the backend with <code>uv run lineage-api</code>.
              </div>
            )}

            <div className="shortcut-hint">
              <span>
                <kbd>/</kbd>search
              </span>
              <span>
                <kbd>F</kbd>focus
              </span>
              <span>
                <kbd>L</kbd>layout
              </span>
              <span>
                <kbd>Z</kbd>fit
              </span>
              <span>
                <kbd>⇧</kbd>box select
              </span>
              <span>
                <kbd>?</kbd>help
              </span>
            </div>

            {toast && <div className="toast">{toast}</div>}
          </>
        )}
      </div>
      <CompareDialog />
      <Tour />
    </div>
  )
}
