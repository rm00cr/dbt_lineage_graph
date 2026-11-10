/** State comparison helpers: change labels, changed node ids, unified-diff line parsing. */

import type { ChangeStatus, GraphNode } from '../api/types'
import type { ThemeName } from '../theme/useTheme'

export const CHANGE_LABELS: Record<ChangeStatus, string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  unchanged: 'unchanged',
}

export const CHANGE_SYMBOLS: Record<ChangeStatus, string> = {
  added: '+',
  removed: '−',
  modified: '~',
  unchanged: '',
}

/**
 * Change colours per theme: green = added, yellow = modified, red = removed. Concrete hex
 * values because React Flow puts them into SVG (arrow heads, mini-map). Keep in sync with
 * the `--diff-*` tokens in global.css, which style the DOM nodes.
 */
export const CHANGE_PALETTES: Record<ThemeName, Record<ChangeStatus, string>> = {
  dark: { added: '#34d399', modified: '#facc15', removed: '#f87171', unchanged: '#475569' },
  light: { added: '#059669', modified: '#ca8a04', removed: '#dc2626', unchanged: '#cbd5e1' },
}

export function changedIds(nodes: GraphNode[]): string[] {
  return nodes.filter((n) => n.change && n.change !== 'unchanged').map((n) => n.id)
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'file' | 'context' | 'note'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** line numbers in the running (old) / uploaded (new) file, where they apply */
  oldNo: number | null
  newNo: number | null
}

/** Split a unified diff (as returned in `NodeChange.code_diff`) into typed, numbered lines. */
export function parseUnifiedDiff(diff: string | null | undefined): DiffLine[] {
  if (!diff) return []
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const text of diff.split('\n')) {
    if (text.startsWith('--- ') || text.startsWith('+++ ')) {
      lines.push({ kind: 'file', text, oldNo: null, newNo: null })
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      lines.push({ kind: 'hunk', text, oldNo: null, newNo: null })
    } else if (text.startsWith('+')) {
      lines.push({ kind: 'add', text: text.slice(1), oldNo: null, newNo: newNo++ })
    } else if (text.startsWith('-')) {
      lines.push({ kind: 'del', text: text.slice(1), oldNo: oldNo++, newNo: null })
    } else if (text.startsWith(' ')) {
      lines.push({ kind: 'context', text: text.slice(1), oldNo: oldNo++, newNo: newNo++ })
    } else if (text) {
      lines.push({ kind: 'note', text, oldNo: null, newNo: null })
    }
  }
  return lines
}
