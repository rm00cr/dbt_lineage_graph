/**
 * Stages are the layers from pipelines.yaml `layers` (default src / int / out). Every layer
 * has a role from its position in the flow, which drives colours and the pipeline boundary
 * check: src = the first layer (imports), out = the last one (public outputs), int between.
 */

import type { LayerInfo, Stage, StageRole } from '../api/types'

export const OTHER_STAGE = 'other'

const DEFAULT_ROLES: Record<string, StageRole> = { src: 'src', int: 'int', out: 'out' }

/** Role of a node (or ref); without `role` from the API, the default layer names count. */
export function roleOf(item: { stage: Stage; role?: StageRole }): StageRole {
  return item.role ?? DEFAULT_ROLES[item.stage] ?? 'other'
}

/**
 * Stages in flow order: the configured layer order first, then stages it does not know
 * (alphabetically), `other` last.
 */
export function orderStages(present: Iterable<Stage>, layers: LayerInfo[] | string[] = []): Stage[] {
  const known = layers.map((l) => (typeof l === 'string' ? l : l.name))
  const set = new Set(present)
  const unknown = [...set].filter((s) => s !== OTHER_STAGE && !known.includes(s)).sort()
  return [...known, ...unknown, OTHER_STAGE].filter((s) => set.has(s))
}
