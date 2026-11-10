import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode } from '../api/types'
import { mermaidLabel, mermaidMarkdown, toMermaid } from './mermaid'

const node = (
  name: string,
  stage: GraphNode['stage'],
  materialization: GraphNode['materialization'],
  pipeline = 'p1',
  change?: GraphNode['change'],
): GraphNode => ({
  id: `model.proj.${name}`,
  name,
  stage,
  materialization,
  pipeline,
  resource_type: materialization === 'source' ? 'source' : 'model',
  schema_name: null,
  database: null,
  description: null,
  tags: [],
  column_count: 0,
  execution_mode: null,
  change,
})

const edge = (from: string, to: string, cross = false, change?: GraphEdge['change']): GraphEdge => ({
  id: `model.proj.${from}->model.proj.${to}`,
  source: `model.proj.${from}`,
  target: `model.proj.${to}`,
  cross_pipeline: cross,
  change,
})

describe('toMermaid', () => {
  const nodes = [
    node('raw.contracts', 'src', 'source'),
    node('src_contracts', 'src', 'view'),
    node('int_calc', 'int', 'ephemeral'),
    node('out_report', 'out', 'table'),
  ]
  const edges = [edge('raw.contracts', 'src_contracts'), edge('src_contracts', 'int_calc'), edge('int_calc', 'out_report')]

  it('draws one node per model with its shape, edges and stage classes', () => {
    const text = toMermaid(nodes, edges, { title: 'test export' })
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('%% test export')
    expect(lines).toContain('flowchart LR')
    expect(lines).toContain('  n1[("raw.contracts")]')
    expect(lines).toContain('  n2("src_contracts")')
    expect(lines).toContain('  n3(["int_calc"])')
    expect(lines).toContain('  n4["out_report"]')
    expect(lines).toContain('  n1 --> n2')
    expect(lines).toContain('  n3 --> n4')
    expect(lines).toContain('  class n1,n2 src')
    expect(lines).toContain('  class n4 out')
    expect(text).not.toContain('subgraph') // a single pipeline needs no box
    expect(text).not.toContain('linkStyle')
  })

  it('groups by pipeline and dashes cross-pipeline edges', () => {
    const many = [node('a', 'out', 'table', 'bestand mfp'), node('b', 'src', 'view', 'claims')]
    const text = toMermaid(many, [edge('a', 'b', true)], { direction: 'TB' })
    expect(text).toContain('flowchart TB')
    expect(text).toContain('  subgraph pipeline_bestand_mfp["bestand mfp"]')
    expect(text).toContain('  n1 -.-> n2')
    expect(text).toContain('  linkStyle 0 stroke:#c2410c,stroke-dasharray:6 4')
  })

  it('colours by change in a state comparison', () => {
    const diff = [node('a', 'int', 'table', 'p1', 'modified'), node('b', 'out', 'table', 'p1', 'added'), node('c', 'out', 'view', 'p1', 'unchanged')]
    const text = toMermaid(diff, [edge('a', 'b', false, 'added'), edge('a', 'c', false, 'unchanged')], { byChange: true })
    expect(text).toContain('  class n1 modified')
    expect(text).toContain('  class n2 added')
    expect(text).toContain('  class n3 unchanged')
    expect(text).toMatch(/linkStyle 0 stroke:#059669/)
    expect(text).not.toContain('linkStyle 1')
  })

  it('skips edges to nodes that are not exported', () => {
    expect(toMermaid([nodes[0]], edges)).not.toContain('-->')
  })
})

describe('labels and markdown', () => {
  it('escapes quotes and line breaks', () => {
    expect(mermaidLabel('a "quoted"\nname')).toBe('"a #quot;quoted#quot; name"')
  })

  it('wraps in a mermaid fence', () => {
    expect(mermaidMarkdown('flowchart LR\n')).toBe('```mermaid\nflowchart LR\n```\n')
  })
})
