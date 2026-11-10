/**
 * Export for documentation: PNG / SVG image of the canvas and a Mermaid flowchart.
 * Every format exports what the canvas shows: filters and focus "isolate" apply, and a
 * state comparison keeps its colours.
 */

import { useReactFlow } from '@xyflow/react'
import { ClipboardCopy, Download, FileCode2, FileImage, Image as ImageIcon, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { type ImageFormat, downloadText, downloadUrl, nextPaint, renderCanvasImage } from '../export/image'
import { mermaidMarkdown, toMermaid } from '../graph/mermaid'
import { visibleSubgraph } from '../graph/visible'
import { useExplorerStore } from '../store/useExplorerStore'
import { copyToClipboard } from './visual'

function exportName(ext: string): string {
  const { filters, focusMode, highlightedIds, compare } = useExplorerStore.getState()
  const parts = ['dbt-lineage', filters.pipelines.length ? filters.pipelines.join('+') : 'all']
  if (focusMode === 'isolate' && highlightedIds.size > 0) parts.push('focus')
  if (compare) parts.push('compare')
  parts.push(new Date().toISOString().slice(0, 10))
  return `${parts.join('-').replace(/[^A-Za-z0-9+_.-]/g, '_')}.${ext}`
}

function exportTitle(count: number): string {
  const { filters, compare } = useExplorerStore.getState()
  const scope = filters.pipelines.length ? `pipelines ${filters.pipelines.join(', ')}` : 'all pipelines'
  const diff = compare ? `, compared with ${compare.label}` : ''
  return `dbt lineage (${scope}${diff}), ${count} nodes, exported ${new Date().toISOString().slice(0, 10)}`
}

function currentMermaid(): string {
  const { graph, focusMode, highlightedIds, compare } = useExplorerStore.getState()
  const { nodes, edges } = visibleSubgraph(graph, focusMode, highlightedIds)
  return toMermaid(nodes, edges, { byChange: compare !== null, title: exportTitle(nodes.length) })
}

export function ExportMenu({ onToast }: { onToast: (message: string) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ImageFormat | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { getViewport } = useReactFlow()
  const setExporting = useExplorerStore((s) => s.setExporting)
  const count = useExplorerStore(
    (s) => visibleSubgraph(s.graph, s.focusMode, s.highlightedIds).nodes.length,
  )
  const isolating = useExplorerStore((s) => s.focusMode === 'isolate' && s.highlightedIds.size > 0)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const exportImage = async (format: ImageFormat) => {
    const viewportEl = document.querySelector<HTMLElement>('.react-flow__viewport')
    if (!viewportEl) return
    setBusy(format)
    setExporting(true) // full-detail nodes, whatever the zoom
    try {
      await nextPaint()
      const background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
      const url = await renderCanvasImage(format, viewportEl, getViewport().zoom, background)
      downloadUrl(exportName(format), url)
      onToast(`${format.toUpperCase()} exported`)
      setOpen(false)
    } catch (error) {
      onToast(`Export failed: ${(error as Error).message}`)
    } finally {
      setExporting(false)
      setBusy(null)
    }
  }

  const exportMermaid = () => {
    downloadText(exportName('mmd'), currentMermaid())
    onToast('Mermaid file exported')
    setOpen(false)
  }

  const copyMermaid = async () => {
    const ok = await copyToClipboard(mermaidMarkdown(currentMermaid()))
    onToast(ok ? 'Mermaid copied, paste it into Markdown' : 'Copy failed')
    setOpen(false)
  }

  return (
    <div className="export" ref={ref}>
      <button
        type="button"
        className={`btn btn--sm${open ? ' btn--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Export the lineage for documentation"
      >
        <Download size={14} /> Export
      </button>

      {open && (
        <div className="export__menu" role="menu">
          <div className="export__scope">
            {count} nodes, as shown{isolating ? ' (focus: isolate)' : ''}
          </div>
          <button type="button" role="menuitem" className="export__item" disabled={busy !== null} onClick={() => void exportImage('png')}>
            {busy === 'png' ? <Loader2 size={15} className="spin" /> : <FileImage size={15} />}
            <span>
              <strong>PNG image</strong>
              <small>slides, wiki pages, tickets</small>
            </span>
          </button>
          <button type="button" role="menuitem" className="export__item" disabled={busy !== null} onClick={() => void exportImage('svg')}>
            {busy === 'svg' ? <Loader2 size={15} className="spin" /> : <ImageIcon size={15} />}
            <span>
              <strong>SVG image</strong>
              <small>scalable, sharp at any size (browsers)</small>
            </span>
          </button>
          <button type="button" role="menuitem" className="export__item" onClick={exportMermaid}>
            <FileCode2 size={15} />
            <span>
              <strong>Mermaid file (.mmd)</strong>
              <small>diagram as text, versionable</small>
            </span>
          </button>
          <button type="button" role="menuitem" className="export__item" onClick={() => void copyMermaid()}>
            <ClipboardCopy size={15} />
            <span>
              <strong>Copy Mermaid for Markdown</strong>
              <small>GitHub, GitLab, Confluence, Notion</small>
            </span>
          </button>
          <div className="export__hint">
            Filters and focus “isolate” decide what is exported. Images use the current theme.
          </div>
        </div>
      )}
    </div>
  )
}
