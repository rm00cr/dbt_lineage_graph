/**
 * Stacked execution modes on the canvas: which mode tabs and how many back cards a node
 * gets. A node of a stacked pipeline carries `modes` (front mode first, see contract 2.8b):
 *
 *   in the front mode   front card + one back card per other selected mode containing it
 *   only in back modes  a ghost card (`front: false`), no back cards
 *
 * Every node of a stacked pipeline gets STACK_HEAD extra height above its card for the
 * tabs and the offset back cards, so the layout keeps them apart.
 */

import type { GraphNode } from '../api/types'

export const STACK_HEAD = 40
export const STACK_OFFSET = 9
export const MAX_BACK_LAYERS = 2

export interface StackTab {
  mode: string
  /** the card in front shows this mode */
  front: boolean
  /** this back mode compiles the model to other SQL than the front mode */
  differs: boolean
}

export function isStacked(node: GraphNode): boolean {
  return Boolean(node.modes && node.modes.length > 0)
}

export function isGhost(node: GraphNode): boolean {
  return isStacked(node) && node.front === false
}

export function stackTabs(node: GraphNode): StackTab[] {
  if (!node.modes) return []
  const differs = new Set(node.sql_differs ?? [])
  const ghost = node.front === false
  return node.modes.map((mode, index) => ({
    mode,
    front: !ghost && index === 0,
    differs: differs.has(mode),
  }))
}

/** back cards drawn behind the front card */
export function backLayers(node: GraphNode): number {
  if (!node.modes || node.front === false) return 0
  return Math.min(node.modes.length - 1, MAX_BACK_LAYERS)
}

/**
 * Which card a tab sits on: 0 = the front (or ghost) card, d = the d-th back card. Modes
 * beyond the drawn back cards share the last one.
 */
export function tabDepth(node: GraphNode, index: number): number {
  return Math.min(index, backLayers(node))
}
