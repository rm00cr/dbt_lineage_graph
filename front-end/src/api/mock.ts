/**
 * Offline fallback so the frontend stays usable when the API is down
 * (that is the AP-2 / AP-3 "work against mocks" path). A banner tells the user.
 */

import type {
  ColumnLineageEdge,
  ColumnLineageResponse,
  ColumnNode,
  DiffResponse,
  GenerationJob,
  GraphNode,
  GraphResponse,
  MetaResponse,
  ModelDetail,
  NodeChange,
  PipelineInfo,
  TraceDirection,
} from './types'

const node = (
  name: string,
  stage: GraphNode['stage'],
  materialization: GraphNode['materialization'],
  pipeline: string,
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id: `model.pnc_analytics.${name}`,
  name,
  stage,
  materialization,
  pipeline,
  resource_type: 'model',
  schema_name: `${pipeline.split('_')[1] ?? 'mfp'}_${stage}`,
  database: 'pnc-analytics-prd',
  description: `Mock node ${name}.`,
  tags: [pipeline.split('_')[1] ?? 'mfp'],
  column_count: 6,
  execution_mode: 'daily',
  ...extra,
})

const NODES: GraphNode[] = [
  {
    id: 'source.pnc_analytics.raw_mfp.contracts',
    name: 'raw_mfp.contracts',
    stage: 'src',
    materialization: 'source',
    pipeline: 'bestand_mfp',
    resource_type: 'source',
    schema_name: 'raw_mfp',
    database: 'pnc-raw-prd',
    description: 'Mock raw contracts source.',
    tags: ['source'],
    column_count: 8,
    execution_mode: null,
  },
  node('src_mfp_contracts', 'src', 'view', 'bestand_mfp', { folder: 'contracts' }),
  node('src_mfp_partners', 'src', 'view', 'bestand_mfp', { folder: 'partners' }),
  node('int_mfp_contracts', 'int', 'table', 'bestand_mfp', { folder: 'contracts' }),
  node('int_mfp_coverages', 'int', 'incremental', 'bestand_mfp', { folder: 'premium' }),
  node('int_mfp_premium_calc', 'int', 'ephemeral', 'bestand_mfp', { folder: 'premium' }),
  node('out_mfp_portfolio_daily', 'out', 'incremental', 'bestand_mfp', { folder: 'reporting' }),
  node('out_mfp_premium_report', 'out', 'table', 'bestand_mfp', { folder: 'reporting' }),
  node('int_claims_cases', 'int', 'table', 'schaden_claims', { folder: 'cases' }),
  node('out_claims_kpi_daily', 'out', 'incremental', 'schaden_claims', { folder: 'kpi' }),
]

/** only in the demo comparison (mockCompare): a model the "branch" adds */
const ADDED_NODE = node('out_mfp_premium_monthly', 'out', 'incremental', 'bestand_mfp', { folder: 'reporting' })

const PAIRS: [string, string][] = [
  ['source.pnc_analytics.raw_mfp.contracts', 'model.pnc_analytics.src_mfp_contracts'],
  ['model.pnc_analytics.src_mfp_contracts', 'model.pnc_analytics.int_mfp_contracts'],
  ['model.pnc_analytics.src_mfp_partners', 'model.pnc_analytics.int_mfp_contracts'],
  ['model.pnc_analytics.int_mfp_contracts', 'model.pnc_analytics.int_mfp_premium_calc'],
  ['model.pnc_analytics.int_mfp_coverages', 'model.pnc_analytics.int_mfp_premium_calc'],
  ['model.pnc_analytics.int_mfp_premium_calc', 'model.pnc_analytics.out_mfp_portfolio_daily'],
  ['model.pnc_analytics.int_mfp_premium_calc', 'model.pnc_analytics.out_mfp_premium_report'],
  ['model.pnc_analytics.int_mfp_contracts', 'model.pnc_analytics.int_claims_cases'],
  ['model.pnc_analytics.int_claims_cases', 'model.pnc_analytics.out_claims_kpi_daily'],
]

export const mockGraph: GraphResponse = {
  nodes: NODES,
  edges: PAIRS.map(([source, target]) => {
    const from = NODES.find((n) => n.id === source)
    const to = NODES.find((n) => n.id === target)
    return {
      id: `${source}->${target}`,
      source,
      target,
      cross_pipeline: from?.pipeline !== to?.pipeline,
    }
  }),
  stats: {
    node_count: NODES.length,
    edge_count: PAIRS.length,
    pipelines: ['bestand_mfp', 'schaden_claims'],
    stages: ['src', 'int', 'out'],
    materializations: ['source', 'view', 'table', 'incremental', 'ephemeral'],
  },
}

const MOCK_SQL = `select
    c.contract_id,
    c.partner_id,
    c.product_code,
    c.annual_premium_chf,
    p.canton,
    p.age_years
from \`pnc-analytics-prd\`.mfp_staging.src_mfp_contracts c
left join \`pnc-analytics-prd\`.mfp_staging.src_mfp_partners p using (partner_id)
`

export function mockModelDetail(id: string): ModelDetail {
  const found = [...NODES, ADDED_NODE].find((n) => n.id === id) ?? NODES[3]
  return {
    ...found,
    alias: found.name,
    original_file_path: `models/${found.pipeline}/${found.stage}/${found.name}.sql`,
    compiled_code: found.resource_type === 'source' ? null : MOCK_SQL,
    raw_code: found.resource_type === 'source' ? null : `{{ config(materialized='${found.materialization}') }}\n\n${MOCK_SQL}`,
    dependencies: mockGraph.edges
      .filter((e) => e.target === found.id)
      .map((e) => NODES.find((n) => n.id === e.source)!)
      .filter(Boolean),
    dependents: mockGraph.edges
      .filter((e) => e.source === found.id)
      .map((e) => NODES.find((n) => n.id === e.target)!)
      .filter(Boolean),
    columns: [
      { name: 'contract_id', type: 'STRING', description: 'Technical contract key.', index: 1 },
      { name: 'partner_id', type: 'STRING', description: 'Policy holder reference.', index: 2 },
      { name: 'product_code', type: 'STRING', description: 'PnC product code.', index: 3 },
      { name: 'annual_premium_chf', type: 'NUMERIC', description: 'Gross annual premium in CHF.', index: 4 },
      { name: 'canton', type: 'STRING', description: 'Swiss canton code.', index: 5 },
      { name: 'age_years', type: 'INT64', description: 'Age of the policy holder.', index: 6 },
    ].map((column) => ({
      ...column,
      upstream_count: mockGraph.edges.some((e) => e.target === found.id) ? 1 : 0,
      downstream_count: mockGraph.edges.filter((e) => e.source === found.id).length,
    })),
    stats: { row_count: 4812004, size_bytes: 1073741824 },
    bigquery: {
      project: 'pnc-analytics-prd',
      dataset: found.schema_name ?? 'mfp_intermediate',
      table: found.name,
      console_url: 'https://console.cloud.google.com/bigquery',
      query_url: null,
    },
    dbt_run_command: found.resource_type === 'model' ? `dbt run --select ${found.name}` : null,
  }
}

/**
 * Offline column trace: pretends every column passes through unchanged along the mock
 * model edges. Good enough to exercise the UI without a backend.
 */
export function mockColumnLineage(
  modelId: string,
  column: string,
  direction: TraceDirection = 'both',
): ColumnLineageResponse {
  const name = (id: string) => NODES.find((n) => n.id === id)?.name ?? id
  const nodes = new Map<string, ColumnNode>()
  const edges: ColumnLineageEdge[] = []
  const root: ColumnNode = { model_id: modelId, model_name: name(modelId), column, type: null, distance: 0 }
  nodes.set(modelId, root)

  const walk = (up: boolean) => {
    const queue: [string, number][] = [[modelId, 0]]
    const seen = new Set([modelId])
    while (queue.length > 0) {
      const [current, distance] = queue.shift()!
      for (const edge of mockGraph.edges) {
        const next = up ? (edge.target === current ? edge.source : null) : edge.source === current ? edge.target : null
        if (!next) continue
        const [source, target] = up ? [next, current] : [current, next]
        edges.push({
          id: `${source}.${column}->${target}.${column}`,
          source_model: source,
          source_column: column,
          target_model: target,
          target_column: column,
          kind: 'passthrough',
          expression: null,
        })
        if (seen.has(next)) continue
        seen.add(next)
        nodes.set(next, { model_id: next, model_name: name(next), column, type: null, distance: distance + 1 })
        queue.push([next, distance + 1])
      }
    }
  }
  if (direction !== 'down') walk(true)
  if (direction !== 'up') walk(false)

  return {
    root,
    direction,
    depth: null,
    nodes: [...nodes.values()],
    edges: [...new Map(edges.map((e) => [e.id, e])).values()],
    warnings: ['Mock data: every column is assumed to pass through unchanged.'],
  }
}

// ------------------------------------------------------------------ demo project (guided tours)
// The tours run on this mock project, so every step has something to show whatever project
// is loaded: folders, execution modes, background jobs and a comparison included.

const DEMO_GENERATED_AT = '2026-01-15T07:30:00Z'

export const mockMeta: MetaResponse = {
  project_names: ['pnc_analytics'],
  adapter_type: 'bigquery',
  dbt_version: '1.9.0',
  generated_at: DEMO_GENERATED_AT,
  pipelines: mockGraph.stats.pipelines,
  stages: mockGraph.stats.stages,
  materializations: mockGraph.stats.materializations,
  tags: ['mfp', 'claims', 'source'],
  node_count: NODES.length,
  edge_count: PAIRS.length,
  source_count: NODES.filter((n) => n.resource_type === 'source').length,
  model_count: NODES.filter((n) => n.resource_type === 'model').length,
}

const demoMode = (name: string) => ({
  name,
  vars: { run_mode: name },
  available: true,
  generated_at: DEMO_GENERATED_AT,
  manifest: `target/${name}/manifest.json`,
})

export const mockPipelineInfo: PipelineInfo[] = [
  {
    name: 'bestand_mfp',
    layers: ['src', 'int', 'out'],
    active_mode: 'daily',
    stacked_modes: [],
    available: true,
    generated_at: DEMO_GENERATED_AT,
    can_generate: true,
    modes: [demoMode('daily'), demoMode('monthly')],
  },
  {
    name: 'schaden_claims',
    layers: ['src', 'int', 'out'],
    active_mode: null,
    available: true,
    generated_at: DEMO_GENERATED_AT,
    can_generate: true,
    modes: [],
  },
]

/** one running, one failed, one finished run; times relative to `now` */
export function mockJobs(now = Date.now()): GenerationJob[] {
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
  return [
    {
      id: 'demo-job-running',
      pipeline: 'bestand_mfp',
      mode: 'monthly',
      trigger: 'user',
      status: 'running',
      started_at: ago(42),
      finished_at: null,
      error: null,
      command: 'dbt docs generate --vars {run_mode: monthly}',
      log_tail: [
        'Running with dbt=1.9.0',
        'Found 9 models, 1 source, 0 tests',
        'Concurrency: 8 threads (target=prd)',
        'Building catalog',
      ],
    },
    {
      id: 'demo-job-failed',
      pipeline: 'schaden_claims',
      mode: null,
      trigger: 'startup',
      status: 'failed',
      started_at: ago(900),
      finished_at: ago(871),
      error: "Compilation Error in model int_claims_cases: depends on 'src_claims_cases', which was not found",
      command: 'dbt docs generate',
      log_tail: [
        'Running with dbt=1.9.0',
        'Compilation Error in model int_claims_cases (models/02_intermediate/cases/int_claims_cases.sql)',
        "  Model 'int_claims_cases' depends on a node named 'src_claims_cases' which was not found",
      ],
    },
    {
      id: 'demo-job-done',
      pipeline: 'bestand_mfp',
      mode: 'daily',
      trigger: 'startup',
      status: 'done',
      started_at: ago(960),
      finished_at: ago(905),
      error: null,
      command: 'dbt docs generate --vars {run_mode: daily}',
      log_tail: ['Catalog written to target/daily/catalog.json'],
    },
  ]
}

/** the modified model of the demo comparison: the compare tour opens it on its Changes tab */
export const MOCK_COMPARE_MODIFIED_ID = 'model.pnc_analytics.int_mfp_premium_calc'
const REMOVED_ID = 'model.pnc_analytics.out_mfp_premium_report'

const MODIFIED_DIFF = [
  '--- running/int_mfp_premium_calc.sql',
  '+++ feature/monthly-premium/int_mfp_premium_calc.sql',
  '@@ -1,6 +1,7 @@',
  "-{{ config(materialized='ephemeral') }}",
  "+{{ config(materialized='table') }}",
  ' select',
  '     c.contract_id,',
  '     c.annual_premium_chf,',
  '+    c.annual_premium_chf * 0.05 as premium_tax_chf,',
  '     cov.coverage_code',
  " from {{ ref('int_mfp_contracts') }} c",
].join('\n')

/** a branch that adds a monthly report, changes the premium calculation and drops a report */
export function mockCompare(): DiffResponse {
  const status = (id: string): GraphNode['change'] =>
    id === MOCK_COMPARE_MODIFIED_ID ? 'modified' : id === REMOVED_ID ? 'removed' : null
  const nodes: GraphNode[] = [
    ...NODES.map((n) => ({ ...n, change: status(n.id) })),
    { ...ADDED_NODE, change: 'added' },
  ]
  const edges = [
    ...mockGraph.edges.map((e) => ({ ...e, change: e.target === REMOVED_ID ? ('removed' as const) : null })),
    {
      id: `${MOCK_COMPARE_MODIFIED_ID}->${ADDED_NODE.id}`,
      source: MOCK_COMPARE_MODIFIED_ID,
      target: ADDED_NODE.id,
      cross_pipeline: false,
      change: 'added' as const,
    },
  ]
  const modified = NODES.find((n) => n.id === MOCK_COMPARE_MODIFIED_ID)!
  const modifiedRef = {
    id: modified.id,
    name: modified.name,
    stage: modified.stage,
    materialization: modified.materialization,
    pipeline: modified.pipeline,
    resource_type: modified.resource_type,
  }
  const changes: NodeChange[] = [
    {
      id: ADDED_NODE.id,
      name: ADDED_NODE.name,
      status: 'added',
      fields: [],
      columns: [],
      code_changed: true,
      code_diff: null,
      upstream_added: [modifiedRef],
      upstream_removed: [],
    },
    {
      id: modified.id,
      name: modified.name,
      status: 'modified',
      fields: [{ field: 'materialization', base: 'ephemeral', head: 'table' }],
      columns: [{ name: 'premium_tax_chf', change: 'added', base_type: null, head_type: 'NUMERIC' }],
      code_changed: true,
      code_diff: MODIFIED_DIFF,
      upstream_added: [],
      upstream_removed: [],
    },
    {
      id: REMOVED_ID,
      name: 'out_mfp_premium_report',
      status: 'removed',
      fields: [],
      columns: [],
      code_changed: false,
      code_diff: null,
      upstream_added: [],
      upstream_removed: [modifiedRef],
    },
  ]
  const state = (label: string) => ({
    label,
    project_names: ['pnc_analytics'],
    dbt_version: '1.9.0',
    generated_at: DEMO_GENERATED_AT,
    catalog_loaded: true,
    node_count: NODES.length,
  })
  return {
    state_id: 'demo-compare',
    pipeline: 'bestand_mfp',
    base: state('running'),
    head: state('feature/monthly-premium'),
    summary: { added: 1, removed: 1, modified: 1, unchanged: NODES.length - 2, edges_added: 1, edges_removed: 1 },
    columns_compared: true,
    graph: { nodes, edges, stats: { ...mockGraph.stats, node_count: nodes.length, edge_count: edges.length } },
    changes,
    warnings: [],
  }
}
