/**
 * CodeViewer (AP-3, feature 1.2): compiled / raw SQL with syntax highlighting,
 * line numbers and a copy button.
 */

import { Check, Copy, Download, WrapText } from 'lucide-react'
import { Highlight, themes } from 'prism-react-renderer'
import { useState } from 'react'

import { usePanelPrefs } from '../store/usePanelPrefs'
import { useTheme } from '../theme/useTheme'
import { copyToClipboard } from './visual'

interface CodeViewerProps {
  compiled: string | null
  raw: string | null
  fileName: string
}

type Variant = 'compiled' | 'raw'

export function CodeViewer({ compiled, raw, fileName }: CodeViewerProps) {
  const [variant, setVariant] = useState<Variant>(compiled ? 'compiled' : 'raw')
  const [copied, setCopied] = useState(false)
  const theme = useTheme((s) => s.resolved)
  const wrap = usePanelPrefs((s) => s.wrap)

  const code = (variant === 'compiled' ? compiled : raw) ?? ''

  if (!compiled && !raw) {
    return <div className="empty">No SQL for this node — dbt sources have no model code.</div>
  }

  const copy = async () => {
    const ok = await copyToClipboard(code)
    if (!ok) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const download = () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${fileName}.${variant}.sql`
    link.click()
    URL.revokeObjectURL(url)
  }

  const lineCount = code.split('\n').length

  return (
    <div className="code">
      <div className="code__bar">
        <div className="code__toggle">
          <button data-active={variant === 'compiled'} disabled={!compiled} onClick={() => setVariant('compiled')}>
            compiled
          </button>
          <button data-active={variant === 'raw'} disabled={!raw} onClick={() => setVariant('raw')}>
            raw (jinja)
          </button>
        </div>

        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
          {lineCount} lines
        </span>

        <WrapToggle />
        <button className="btn btn--sm btn--icon" onClick={download} title="Download as .sql">
          <Download size={13} />
        </button>
        <button className="btn btn--sm" onClick={() => void copy()} title="Copy SQL to clipboard">
          {copied ? <Check size={13} color="var(--ok)" /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <Highlight
        code={code.trimEnd()}
        language="sql"
        theme={theme === 'light' ? themes.oneLight : themes.vsDark}
      >
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className={`code__lines${wrap ? ' code__lines--wrap' : ''}`}>
            {tokens.map((line, lineIndex) => {
              const lineProps = getLineProps({ line })
              return (
                <div key={lineIndex} {...lineProps} className={`code__line ${lineProps.className ?? ''}`}>
                  <span className="code__lineno">{lineIndex + 1}</span>
                  <span className="code__text">
                    {line.map((token, tokenIndex) => (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </div>
              )
            })}
          </pre>
        )}
      </Highlight>
    </div>
  )
}

/** Word wrap on/off for every code view of the panel (Alt+Z, as in VS Code). */
export function WrapToggle() {
  const wrap = usePanelPrefs((s) => s.wrap)
  const toggleWrap = usePanelPrefs((s) => s.toggleWrap)
  return (
    <button
      className={`btn btn--sm btn--icon${wrap ? ' btn--active' : ''}`}
      aria-pressed={wrap}
      onClick={toggleWrap}
      title={wrap ? 'Word wrap is on (Alt+Z)' : 'Word wrap (Alt+Z)'}
    >
      <WrapText size={13} />
    </button>
  )
}
