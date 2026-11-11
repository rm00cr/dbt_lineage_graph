import { describe, expect, it } from 'vitest'

import { PIPELINE_SLOTS, pipelineColor, pipelineFromId } from './pipelines'

describe('pipelineColor', () => {
  const configured = ['bestand', 'claims', 'finance', 'hr']

  it('gives each pipeline a fixed slot by its configured position', () => {
    expect(pipelineColor(configured, 'bestand')).toBe('var(--pipeline-1)')
    expect(pipelineColor(configured, 'finance')).toBe('var(--pipeline-3)')
  })

  it('never repeats a hue: pipelines past the slots and unknown ones are neutral', () => {
    expect(configured.length).toBeGreaterThan(PIPELINE_SLOTS)
    expect(pipelineColor(configured, 'hr')).toBe('var(--pipeline-other)')
    expect(pipelineColor(configured, 'upload')).toBe('var(--pipeline-other)')
  })
})

describe('pipelineFromId', () => {
  it('reads the pipeline segment of a node id', () => {
    expect(pipelineFromId('model.bestand_mfp.out_mfp_contracts')).toBe('bestand_mfp')
    expect(pipelineFromId('source.schaden_claims.bestand_mfp.out_mfp_contracts')).toBe('schaden_claims')
  })
})
