/**
 * Theme: light / dark / follow the system.
 *
 * The resolved theme is stamped on <html data-theme="…"> so the whole stylesheet can
 * switch with one attribute, and the choice is remembered per browser.
 */

import { useEffect } from 'react'
import { create } from 'zustand'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ThemeName = 'light' | 'dark'

const STORAGE_KEY = 'lineage-explorer.theme'

function systemTheme(): ThemeName {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function storedPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    /* private mode / blocked storage — fall back to the system preference */
  }
  return 'system'
}

function resolve(preference: ThemePreference): ThemeName {
  return preference === 'system' ? systemTheme() : preference
}

function apply(theme: ThemeName) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
}

interface ThemeState {
  preference: ThemePreference
  resolved: ThemeName
  setPreference: (preference: ThemePreference) => void
  syncWithSystem: () => void
}

const initialPreference = typeof window === 'undefined' ? 'system' : storedPreference()
const initialResolved = resolve(initialPreference)
apply(initialResolved)

export const useTheme = create<ThemeState>((set, get) => ({
  preference: initialPreference,
  resolved: initialResolved,

  setPreference: (preference) => {
    const resolved = resolve(preference)
    apply(resolved)
    try {
      window.localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      /* not fatal — the choice just will not survive a reload */
    }
    set({ preference, resolved })
  },

  syncWithSystem: () => {
    if (get().preference !== 'system') return
    const resolved = systemTheme()
    apply(resolved)
    set({ resolved })
  },
}))

/** Keeps "system" in sync while the app is open. Call once, in App. */
export function useSystemThemeListener() {
  const syncWithSystem = useTheme((s) => s.syncWithSystem)

  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => syncWithSystem()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [syncWithSystem])
}
