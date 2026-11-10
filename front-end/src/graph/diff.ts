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

/**
 * Line diff of two texts in the browser (stacked execution modes: the SQL of one model in
 * two modes). LCS over the lines after trimming the common start and end; unchanged runs
 * longer than 2 * `context` lines are folded into one `hunk` line, like a unified diff.
 */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  type Op = { kind: 'context' | 'del' | 'add'; text: string }
  const ops: Op[] = a.slice(0, start).map((text) => ({ kind: 'context' as const, text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  if (n * m > 4_000_000) {
    // too big for a table: show the changed middle as replaced
    ops.push(...midA.map((text) => ({ kind: 'del' as const, text })), ...midB.map((text) => ({ kind: 'add' as const, text })))
  } else {
    const lcs = new Uint32Array((n + 1) * (m + 1))
    const at = (i: number, j: number) => i * (m + 1) + j
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[at(i, j)] = midA[i] === midB[j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ kind: 'context', text: midA[i] })
        i++
        j++
      } else if (j < m && (i === n || lcs[at(i, j + 1)] > lcs[at(i + 1, j)])) {
        // on a tie the removal goes first, as in git
        ops.push({ kind: 'add', text: midB[j++] })
      } else {
        ops.push({ kind: 'del', text: midA[i++] })
      }
    }
  }
  ops.push(...a.slice(endA).map((text) => ({ kind: 'context' as const, text })))

  // number the lines, then fold long unchanged runs
  let oldNo = 1
  let newNo = 1
  const numbered: DiffLine[] = ops.map((op) => {
    if (op.kind === 'context') return { kind: 'context', text: op.text, oldNo: oldNo++, newNo: newNo++ }
    if (op.kind === 'del') return { kind: 'del', text: op.text, oldNo: oldNo++, newNo: null }
    return { kind: 'add', text: op.text, oldNo: null, newNo: newNo++ }
  })
  const lines: DiffLine[] = []
  for (let k = 0; k < numbered.length; ) {
    if (numbered[k].kind !== 'context') {
      lines.push(numbered[k++])
      continue
    }
    let end = k
    while (end < numbered.length && numbered[end].kind === 'context') end++
    const keepHead = k === 0 ? 0 : context
    const keepTail = end === numbered.length ? 0 : context
    if (end - k > keepHead + keepTail + 1) {
      lines.push(...numbered.slice(k, k + keepHead))
      const hidden = end - k - keepHead - keepTail
      lines.push({ kind: 'hunk', text: `⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}`, oldNo: null, newNo: null })
      lines.push(...numbered.slice(end - keepTail, end))
    } else {
      lines.push(...numbered.slice(k, end))
    }
    k = end
  }
  return lines
}
