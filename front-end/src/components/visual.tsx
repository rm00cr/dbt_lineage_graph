/** Shared visual language: stage colours, materialization icons, formatters. */

import {
  Box,
  Boxes,
  Database,
  FlaskConical,
  Eye,
  Ghost,
  Layers,
  type LucideIcon,
} from 'lucide-react'

import { useCallback, useMemo } from 'react'

import type { ChangeStatus, Materialization, Stage, StageRole } from '../api/types'
import { CHANGE_PALETTES } from '../graph/diff'
import { roleOf } from '../graph/stage'
import { useExplorerStore } from '../store/useExplorerStore'
import { type ThemeName, useTheme } from '../theme/useTheme'

/**
 * Stage colours per theme, by the role of the stage (first layer, middle, last layer). The light variants are darker so they keep their contrast on a
 * white canvas; the dark ones glow on the near-black one.
 */
export const STAGE_PALETTES: Record<ThemeName, Record<StageRole, string>> = {
  dark: {
    src: '#22d3ee',
    int: '#a78bfa',
    out: '#fb923c',
    other: '#94a3b8',
  },
  light: {
    src: '#0e7490',
    int: '#6d28d9',
    out: '#c2410c',
    other: '#64748b',
  },
}

/** labels of the default layers; configured layers bring their own (meta `layers`) */
const DEFAULT_STAGE_LABELS: Record<string, string> = {
  src: 'Source',
  int: 'Intermediate',
  out: 'Output',
  other: 'Other',
}

export const MATERIALIZATION_ICONS: Record<Materialization, LucideIcon> = {
  table: Box,
  view: Eye,
  incremental: Layers,
  ephemeral: Ghost,
  source: Database,
  test: FlaskConical,
  other: Boxes,
}

export const MATERIALIZATION_LABELS: Record<Materialization, string> = {
  table: 'table',
  view: 'view',
  incremental: 'incremental',
  ephemeral: 'ephemeral',
  source: 'source',
  test: 'test',
  other: 'other',
}

export function stageColor(role: StageRole, theme: ThemeName): string {
  const palette = STAGE_PALETTES[theme] ?? STAGE_PALETTES.dark
  return palette[role] ?? palette.other
}

/** A node or ref (its own role wins), or a bare stage name (role from the configured layers). */
export type StageTarget = Stage | { stage: Stage; role?: StageRole }

export interface StageInfo {
  label: (stage: Stage) => string
  role: (stage: Stage) => StageRole
  color: (target: StageTarget) => string
}

/** Labels, roles and colours of the configured layers, bound to the active theme. */
export function useStages(): StageInfo {
  const theme = useTheme((s) => s.resolved)
  const layers = useExplorerStore((s) => s.meta?.layers)
  return useMemo(() => {
    const byName = new Map((layers ?? []).map((l) => [l.name, l]))
    const role = (stage: Stage) => byName.get(stage)?.role ?? roleOf({ stage })
    const label = (stage: Stage) => byName.get(stage)?.label ?? DEFAULT_STAGE_LABELS[stage] ?? stage
    const color = (target: StageTarget) =>
      stageColor(typeof target === 'string' ? role(target) : (target.role ?? role(target.stage)), theme)
    return { label, role, color }
  }, [theme, layers])
}

/** Stage colour resolver bound to the active theme — re-renders when the theme flips. */
export function useStageColor(): (target: StageTarget) => string {
  return useStages().color
}

/** State comparison colour resolver bound to the active theme. */
export function useChangeColor(): (change: ChangeStatus | null | undefined) => string {
  const theme = useTheme((s) => s.resolved)
  return useCallback(
    (change: ChangeStatus | null | undefined) => (CHANGE_PALETTES[theme] ?? CHANGE_PALETTES.dark)[change ?? 'unchanged'],
    [theme],
  )
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–'
  return new Intl.NumberFormat('de-CH').format(value)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes === 0) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}
