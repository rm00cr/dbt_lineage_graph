import { describe, expect, it } from 'vitest'

import { MAX_NAME_LINES, NAME_LINE_HEIGHT, cardHeight, nameLines } from './layout'

describe('card height follows the model name', () => {
  it('wraps at _ and . like the card does', () => {
    expect(nameLines('raw_mfp.coverages', 23)).toBe(1)
    expect(nameLines('int_mfp_contract_coverage', 23)).toBe(2) // "int_mfp_contract_" / "coverage"
    expect(nameLines('bestand_mfp.out_mfp_premium_report', 23)).toBe(2)
    // a part without break points breaks anywhere
    expect(nameLines('averyveryverylongmodelnamewithoutbreaks', 23)).toBe(2)
  })

  it('gives short names a compact card and long names one line more each', () => {
    const one = cardHeight({ name: 'raw_mfp.coverages' })
    const two = cardHeight({ name: 'int_mfp_contract_coverage' })
    expect(one).toBeLessThan(90)
    expect(two - one).toBeGreaterThan(0)
    expect(cardHeight({ name: 'a_very_long_model_name_with_many_parts_that_wraps_a_lot' }) - two).toBe(NAME_LINE_HEIGHT)
  })

  it('reserves room for a compare tag, and never grows past the line cap', () => {
    const name = 'int_mfp_contracts'
    expect(cardHeight({ name, change: 'modified' })).toBeGreaterThan(cardHeight({ name }))
    expect(cardHeight({ name, change: 'unchanged' })).toBe(cardHeight({ name }))
    const huge = cardHeight({ name: 'x_'.repeat(200) })
    expect(huge).toBe(cardHeight({ name: 'x_'.repeat(400) }))
    expect(huge).toBeLessThanOrEqual(55 + MAX_NAME_LINES * NAME_LINE_HEIGHT)
  })
})
