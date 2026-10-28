/** Shared visual language: stage colours, materialization icons, formatters. */

import {
  Box,
  Boxes,
  Database,
  Eye,
  Ghost,
  Layers,
  type LucideIcon,
} from 'lucide-react'

import { useCallback } from 'react'

import type { Materialization, Stage } from '../api/types'
import { type ThemeName, useTheme } from '../theme/useTheme'

/**
 * Stage colours per theme. The light variants are darker so they keep their contrast on a
 * white canvas; the dark ones glow on the near-black one.
 */
export const STAGE_PALETTES: Record<ThemeName, Record<Stage, string>> = {
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

export const STAGE_LABELS: Record<Stage, string> = {
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
  other: Boxes,
}

export const MATERIALIZATION_LABELS: Record<Materialization, string> = {
  table: 'table',
  view: 'view',
  incremental: 'incremental',
  ephemeral: 'ephemeral',
  source: 'source',
  other: 'other',
}

export function stageColor(stage: Stage, theme: ThemeName): string {
  const palette = STAGE_PALETTES[theme] ?? STAGE_PALETTES.dark
  return palette[stage] ?? palette.other
}

/** Stage colour resolver bound to the active theme — re-renders when the theme flips. */
export function useStageColor(): (stage: Stage) => string {
  const theme = useTheme((s) => s.resolved)
  return useCallback((stage: Stage) => stageColor(stage, theme), [theme])
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
