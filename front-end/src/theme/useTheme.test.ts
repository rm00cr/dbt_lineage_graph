/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest'

import { useTheme } from './useTheme'

/** jsdom has no matchMedia — stub it so "system" can be exercised in both directions. */
function stubSystemTheme(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('dark') ? prefersDark : !prefersDark,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
}

describe('useTheme', () => {
  beforeEach(() => {
    window.localStorage.clear()
    stubSystemTheme(false)
    useTheme.setState({ preference: 'system', resolved: 'dark' })
  })

  it('stamps the resolved theme on <html>', () => {
    useTheme.getState().setPreference('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    useTheme.getState().setPreference('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('remembers the choice', () => {
    useTheme.getState().setPreference('light')
    expect(window.localStorage.getItem('lineage-explorer.theme')).toBe('light')
  })

  it('resolves "system" from the media query', () => {
    useTheme.getState().setPreference('system')
    expect(useTheme.getState().resolved).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    stubSystemTheme(true)
    useTheme.getState().syncWithSystem()
    expect(useTheme.getState().resolved).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('ignores system changes once the user picked a theme', () => {
    useTheme.getState().setPreference('dark')
    stubSystemTheme(false)
    useTheme.getState().syncWithSystem()
    expect(useTheme.getState().resolved).toBe('dark')
  })
})
