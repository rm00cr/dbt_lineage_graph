/** Legend: the visual language of the canvas (stage colours + materialization icons). */

import { useExplorerStore } from '../store/useExplorerStore'
import { MATERIALIZATION_ICONS, STAGE_LABELS, useStageColor } from './visual'

const MATERIALIZATIONS = ['table', 'view', 'incremental', 'ephemeral', 'source'] as const

export function Legend() {
  const graph = useExplorerStore((s) => s.graph)
  const stageColor = useStageColor()
  const stages = (graph?.stats.stages ?? ['src', 'int', 'out']) as ('src' | 'int' | 'out')[]

  return (
    <div className="legend">
      <div className="legend__title">Stage</div>
      <div className="legend__row">
        {stages.map((stage) => (
          <span className="legend__item" key={stage}>
            <span
              className="legend__swatch"
              style={{ background: stageColor(stage), color: stageColor(stage) }}
            />
            {STAGE_LABELS[stage]}
          </span>
        ))}
      </div>

      <div className="legend__title" style={{ marginTop: 3 }}>
        Materialization
      </div>
      <div className="legend__row" style={{ flexWrap: 'wrap', maxWidth: 280, rowGap: 6 }}>
        {MATERIALIZATIONS.map((materialization) => {
          const Icon = MATERIALIZATION_ICONS[materialization]
          return (
            <span className="legend__mat" key={materialization}>
              <Icon size={12} /> {materialization}
            </span>
          )
        })}
      </div>

      <div className="legend__row" style={{ marginTop: 3 }}>
        <span className="legend__item">
          <svg width="26" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="26"
              y2="4"
              stroke={stageColor('out')}
              strokeWidth="2"
              strokeDasharray="7 5"
            />
          </svg>
          cross-pipeline edge
        </span>
      </div>
    </div>
  )
}
