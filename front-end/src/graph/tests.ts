/**
 * dbt tests (incl. dq checks) shown inside a node when the Tests toggle is on.
 * Pure functions, so the node height used by the layout can be computed the same way
 * the node renders its list.
 */

import type { GraphResponse, TestInfo } from '../api/types'

export const MAX_TEST_ROWS = 6
export const TEST_ROW_HEIGHT = 22
/** header space + paddings of the test list inside a node (matches `.node__tests`) */
export const TEST_LIST_PADDING = 12

/** The test rows drawn inside a node; the rest are summed up in a "+N more" line. */
export function visibleTests(tests: TestInfo[] | undefined): TestInfo[] {
  return (tests ?? []).slice(0, MAX_TEST_ROWS)
}

/** Short label: `not_null(pol_nr)` for generic tests, the name as is for singular (dq) tests. */
export function testLabel(test: TestInfo): string {
  if (test.kind === 'generic' && test.test_name) {
    return test.column ? `${test.test_name}(${test.column})` : test.test_name
  }
  return test.name
}

/** Extra height a node needs for its test list (0 when there is nothing to draw). */
export function testListExtraHeight(tests: TestInfo[] | undefined, show: boolean): number {
  if (!show || !tests || tests.length === 0) return 0
  const more = tests.length > MAX_TEST_ROWS ? TEST_ROW_HEIGHT : 0
  return TEST_LIST_PADDING + visibleTests(tests).length * TEST_ROW_HEIGHT + more
}

/**
 * The graph without its singular-test nodes (and their edges). Used while the Tests toggle
 * is off, so the layout does not reserve room for hidden nodes.
 */
export function withoutTestNodes(graph: GraphResponse): GraphResponse {
  const hidden = new Set(graph.nodes.filter((n) => n.resource_type === 'test').map((n) => n.id))
  if (hidden.size === 0) return graph
  const nodes = graph.nodes.filter((n) => !hidden.has(n.id))
  const edges = graph.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target))
  return {
    ...graph,
    nodes,
    edges,
    stats: { ...graph.stats, node_count: nodes.length, edge_count: edges.length },
  }
}

/** space between a dq node and the node above it / between dq nodes */
export const TEST_NODE_GAP = 28

type Box = { x: number; y: number; width: number; height: number }

/**
 * Places the singular-test (dq check) nodes under the models they read, in the same column,
 * at the first slot that overlaps no existing node. Existing positions are never changed;
 * several checks on one model stack downwards.
 */
export function placeTestNodes(
  testIds: string[],
  edges: { source: string; target: string }[],
  positions: Map<string, { x: number; y: number }>,
  heightOf: (id: string) => number,
  width: number,
  /** height of a test node: one for all, or per node (cards are sized to their name) */
  testHeight: number | ((id: string) => number),
): Map<string, { x: number; y: number }> {
  const testHeightOf = typeof testHeight === 'number' ? () => testHeight : testHeight
  const obstacles: Box[] = [...positions].map(([id, pos]) => ({
    x: pos.x, y: pos.y, width, height: heightOf(id),
  }))
  const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width + TEST_NODE_GAP / 2 && b.x < a.x + a.width + TEST_NODE_GAP / 2 &&
    a.y < b.y + b.height + TEST_NODE_GAP / 2 && b.y < a.y + a.height + TEST_NODE_GAP / 2

  const anchors = (testId: string) =>
    edges.filter((e) => e.target === testId).map((e) => e.source).filter((id) => positions.has(id))

  // upper checks first, so the ones below them stack in a stable order
  const order = [...testIds].sort((a, b) => {
    const ay = anchors(a).reduce((m, id) => Math.max(m, positions.get(id)!.y), 0)
    const by = anchors(b).reduce((m, id) => Math.max(m, positions.get(id)!.y), 0)
    return ay - by || a.localeCompare(b)
  })

  const placed = new Map<string, { x: number; y: number }>()
  for (const id of order) {
    const ids = anchors(id)
    const x = ids.length ? ids.reduce((sum, a) => sum + positions.get(a)!.x, 0) / ids.length : 0
    const top = ids.length
      ? Math.max(...ids.map((a) => positions.get(a)!.y + heightOf(a))) + TEST_NODE_GAP
      : 0
    let y = top
    for (let guard = 0; guard < 500; guard++) {
      const box: Box = { x, y, width, height: testHeightOf(id) }
      if (!obstacles.some((o) => overlaps(box, o))) break
      // jump past the first obstacle that blocks this slot
      const blocker = obstacles.filter((o) => overlaps(box, o)).reduce((a, b) => (a.y + a.height > b.y + b.height ? a : b))
      y = blocker.y + blocker.height + TEST_NODE_GAP
    }
    placed.set(id, { x, y })
    obstacles.push({ x, y, width, height: testHeightOf(id) })
  }
  return placed
}
