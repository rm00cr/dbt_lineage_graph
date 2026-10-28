/** Light / dark / follow-the-system switch in the top bar. */

import { Monitor, Moon, Sun } from 'lucide-react'

import { type ThemePreference, useTheme } from '../theme/useTheme'

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export function ThemeToggle() {
  const preference = useTheme((s) => s.preference)
  const setPreference = useTheme((s) => s.setPreference)

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          data-active={preference === value}
          onClick={() => setPreference(value)}
          title={`${label} theme`}
          aria-label={`${label} theme`}
          aria-pressed={preference === value}
        >
          <Icon size={14} strokeWidth={2.2} />
        </button>
      ))}
    </div>
  )
}
