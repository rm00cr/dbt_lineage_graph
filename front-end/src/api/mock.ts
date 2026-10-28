/**
 * Offline fallback so the frontend stays usable when the API is down
 * (that is the AP-2 / AP-3 "work against mocks" path). A banner tells the user.
 */

import type { GraphNode, GraphResponse, ModelDetail } from './types'

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
  node('src_mfp_contracts', 'src', 'view', 'bestand_mfp'),
  node('src_mfp_partners', 'src', 'view', 'bestand_mfp'),
  node('int_mfp_contracts', 'int', 'table', 'bestand_mfp'),
  node('int_mfp_coverages', 'int', 'incremental', 'bestand_mfp'),
  node('int_mfp_premium_calc', 'int', 'ephemeral', 'bestand_mfp'),
  node('out_mfp_portfolio_daily', 'out', 'incremental', 'bestand_mfp'),
  node('out_mfp_premium_report', 'out', 'table', 'bestand_mfp'),
  node('int_claims_cases', 'int', 'table', 'schaden_claims'),
  node('out_claims_kpi_daily', 'out', 'incremental', 'schaden_claims'),
]

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
  const found = NODES.find((n) => n.id === id) ?? NODES[3]
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
    ],
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
