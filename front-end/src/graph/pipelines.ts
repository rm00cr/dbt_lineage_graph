/**
 * Pipeline identity colour: one fixed hue per pipeline, shared by its band on the canvas and
 * its chips in the column trace, so the two can be matched at a glance.
 *
 * Colour follows the pipeline, never its rank: the slot comes from the pipeline's position in
 * the configured list (`graph.stats.pipelines`), so filtering pipelines never repaints the rest.
 * Only PIPELINE_SLOTS hues are used (validated for colour-blind separation in both themes, and
 * kept apart from the stage and status colours); later pipelines get a neutral tone instead of
 * a repeated hue. The pipeline name is always shown next to the colour, never colour alone.
 */

export const PIPELINE_SLOTS = 3

/** CSS colour (a theme token) for `pipeline`; `pipelines` is the configured order. */
export function pipelineColor(pipelines: readonly string[], pipeline: string): string {
  const slot = pipelines.indexOf(pipeline)
  return slot >= 0 && slot < PIPELINE_SLOTS ? `var(--pipeline-${slot + 1})` : 'var(--pipeline-other)'
}

/** A node's pipeline from its id (`<type>.<pipeline>.<name...>`), when the graph lacks the node. */
export function pipelineFromId(id: string): string {
  return id.split('.')[1] ?? ''
}
