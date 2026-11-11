/**
 * Export the lineage graph as a Mermaid flowchart, for documentation (Markdown, GitHub,
 * GitLab, Confluence, Notion all render ```mermaid blocks).
 *
 *   - one subgraph per pipeline (when there is more than one)
 *   - node shape by materialization: source = cylinder, view = rounded, ephemeral = stadium,
 *     table / incremental = rectangle
 *   - colour by stage (light palette, readable on white pages); in a state comparison by
 *     change instead: green added, yellow modified, red removed
 *   - cross-pipeline edges dashed; in a comparison added / removed edges coloured
 */

import type { ChangeStatus, GraphEdge, GraphNode, Materialization, Stage } from '../api/types'
import { CHANGE_PALETTES } from './diff'

export interface MermaidOptions {
  direction?: 'LR' | 'TB'
  /** colour by change (state comparison) instead of by stage */
  byChange?: boolean
  /** first comment line, e.g. what was exported and when */
  title?: string
  /** collapsed folder boxes: summary node id -> the models it stands for */
  collapsed?: ReadonlyMap<string, readonly string[]>
}

const SHAPES: Record<Materialization, [string, string]> = {
  source: ['[(', ')]'],
  view: ['(', ')'],
  ephemeral: ['([', '])'],
  table: ['[', ']'],
  incremental: ['[', ']'],
  // singular tests (dq checks): a hexagon, so checks read apart from the models
  test: ['{{', '}}'],
  other: ['[', ']'],
}

// light-theme stage colours (see STAGE_PALETTES.light in components/visual.tsx)
const STAGE_STYLES: Record<Stage, string> = {
  src: 'fill:#ecfeff,stroke:#0e7490,color:#0f172a',
  int: 'fill:#f5f3ff,stroke:#6d28d9,color:#0f172a',
  out: 'fill:#fff7ed,stroke:#c2410c,color:#0f172a',
  other: 'fill:#f8fafc,stroke:#64748b,color:#0f172a',
}

const light = CHANGE_PALETTES.light
const CHANGE_STYLES: Record<ChangeStatus, string> = {
  added: `fill:#ecfdf5,stroke:${light.added},stroke-width:3px,color:#0f172a`,
  modified: `fill:#fefce8,stroke:${light.modified},stroke-width:3px,color:#0f172a`,
  removed: `fill:#fef2f2,stroke:${light.removed},stroke-width:2px,stroke-dasharray:5 4,color:#7f1d1d`,
  unchanged: 'fill:#f8fafc,stroke:#cbd5e1,color:#475569',
}

const CROSS_EDGE_STYLE = 'stroke:#c2410c,stroke-dasharray:6 4'
const EDGE_CHANGE_STYLES: Partial<Record<ChangeStatus, string>> = {
  added: `stroke:${light.added},stroke-width:2.5px`,
  removed: `stroke:${light.removed},stroke-width:2px,stroke-dasharray:4 4`,
}

/** Mermaid labels are quoted; quotes inside must be entity-encoded. */
export function mermaidLabel(text: string): string {
  return `"${text.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ')}"`
}

function subgraphId(pipeline: string): string {
  return `pipeline_${pipeline.replace(/[^A-Za-z0-9_]/g, '_')}`
}

export function toMermaid(nodes: GraphNode[], edges: GraphEdge[], options: MermaidOptions = {}): string {
  const { direction = 'LR', byChange = false, title, collapsed } = options
  const ids = new Map(nodes.map((node, index) => [node.id, `n${index + 1}`]))
  const lines: string[] = []

  if (title) lines.push(`%% ${title}`)
  lines.push(
    `%% ${nodes.length} nodes, shapes: cylinder = source, rounded = view, stadium = ephemeral` +
      (collapsed?.size ? ', double-bordered = collapsed group' : ''),
  )
  lines.push(`flowchart ${direction}`)

  const shape = (node: GraphNode) => {
    const members = collapsed?.get(node.id)
    if (members) {
      // a collapsed folder box: one "subroutine" node standing for its models
      const count = `${members.length} model${members.length === 1 ? '' : 's'}`
      // every stage has a "(root)" group: name the stage so they can be told apart
      const name = node.folder ? node.name : `(root, ${node.stage})`
      return `${ids.get(node.id)}[[${mermaidLabel(`${name} (${count})`)}]]`
    }
    const [open, close] = SHAPES[node.materialization] ?? SHAPES.other
    return `${ids.get(node.id)}${open}${mermaidLabel(node.name)}${close}`
  }

  const pipelines = [...new Set(nodes.map((n) => n.pipeline))]
  if (pipelines.length > 1) {
    for (const pipeline of pipelines) {
      lines.push(`  subgraph ${subgraphId(pipeline)}[${mermaidLabel(pipeline)}]`)
      lines.push(`    direction ${direction}`)
      for (const node of nodes) if (node.pipeline === pipeline) lines.push(`    ${shape(node)}`)
      lines.push('  end')
    }
  } else {
    for (const node of nodes) lines.push(`  ${shape(node)}`)
  }

  // edges, remembering their index for linkStyle
  const edgeStyles = new Map<string, number[]>()
  let index = 0
  for (const edge of edges) {
    const source = ids.get(edge.source)
    const target = ids.get(edge.target)
    if (!source || !target) continue
    lines.push(`  ${source} ${edge.cross_pipeline ? '-.->' : '-->'} ${target}`)
    const style =
      (byChange && edge.change ? EDGE_CHANGE_STYLES[edge.change] : undefined) ??
      (edge.cross_pipeline ? CROSS_EDGE_STYLE : undefined)
    if (style) edgeStyles.set(style, [...(edgeStyles.get(style) ?? []), index])
    index++
  }

  // node colours: one classDef per stage (or change), then the class assignments
  const classOf = (node: GraphNode) => (byChange ? (node.change ?? 'unchanged') : node.stage)
  const styles: Record<string, string> = byChange ? CHANGE_STYLES : STAGE_STYLES
  const members = new Map<string, string[]>()
  for (const node of nodes) {
    const cls = classOf(node)
    members.set(cls, [...(members.get(cls) ?? []), ids.get(node.id)!])
  }
  for (const [cls, nodeIds] of members) {
    lines.push(`  classDef ${cls} ${styles[cls]}`)
    lines.push(`  class ${nodeIds.join(',')} ${cls}`)
  }
  for (const [style, indices] of edgeStyles) lines.push(`  linkStyle ${indices.join(',')} ${style}`)

  return `${lines.join('\n')}\n`
}

/** Wrapped for pasting into Markdown. */
export function mermaidMarkdown(source: string): string {
  return `\`\`\`mermaid\n${source}\`\`\`\n`
}
