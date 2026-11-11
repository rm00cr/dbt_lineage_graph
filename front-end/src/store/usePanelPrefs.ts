/**
 * View preferences of the model side panel, like VS Code's editor chrome:
 *
 *   width / wideWidth   dragged width of the panel (normal, and side-by-side code)
 *   maximized           the panel covers the whole canvas
 *   wrap                long code lines wrap instead of scrolling (Alt+Z)
 *
 * Kept in localStorage so they survive a reload; a null width means "the default".
 */

import { create } from 'zustand'

const STORAGE_KEY = 'lineage-explorer.panel'

interface Persisted {
  width: number | null
  wideWidth: number | null
  wrap: boolean
}

interface PanelPrefs extends Persisted {
  maximized: boolean
  setWidth: (width: number | null, wide: boolean) => void
  toggleMaximized: () => void
  setMaximized: (maximized: boolean) => void
  toggleWrap: () => void
}

/** narrowest the panel can be dragged to */
export const PANEL_MIN_WIDTH = 340

function load(): Persisted {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Persisted>
    const width = (value: unknown) => (typeof value === 'number' && value >= PANEL_MIN_WIDTH ? value : null)
    return { width: width(parsed.width), wideWidth: width(parsed.wideWidth), wrap: parsed.wrap === true }
  } catch {
    return { width: null, wideWidth: null, wrap: false }
  }
}

function save({ width, wideWidth, wrap }: Persisted) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ width, wideWidth, wrap }))
  } catch {
    // storage blocked: the preferences just do not survive a reload
  }
}

export const usePanelPrefs = create<PanelPrefs>((set, get) => ({
  ...load(),
  maximized: false,
  setWidth: (width, wide) => {
    set(wide ? { wideWidth: width } : { width })
    save(get())
  },
  toggleMaximized: () => set((state) => ({ maximized: !state.maximized })),
  setMaximized: (maximized) => set({ maximized }),
  toggleWrap: () => {
    set((state) => ({ wrap: !state.wrap }))
    save(get())
  },
}))
