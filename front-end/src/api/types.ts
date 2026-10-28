/**
 * API contract v0 — keep in sync with ../../../contract.md and
 * ../../../back-end/app/schemas.py (Pydantic).
 */

export type Stage = 'src' | 'int' | 'out' | 'other'
export type Materialization = 'table' | 'view' | 'incremental' | 'ephemeral' | 'source' | 'other'
export type ResourceType = 'model' | 'source'

export interface NodeRef {
  id: string
  name: string
  stage: Stage
  materialization: Materialization
  pipeline: string
  resource_type: ResourceType
}

export interface GraphNode extends NodeRef {
  schema_name: string | null
  database: string | null
  description: string | null
  tags: string[]
  column_count: number
  execution_mode: string | null
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  cross_pipeline: boolean
}

export interface GraphStats {
  node_count: number
  edge_count: number
  pipelines: string[]
  stages: string[]
  materializations: string[]
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
}

export interface ColumnInfo {
  name: string
  type: string | null
  description: string | null
  index: number | null
}

export interface NodeStats {
  row_count: number | null
  size_bytes: number | null
}

export interface BigQueryRef {
  project: string
  dataset: string
  table: string
  console_url: string
  query_url: string | null
}

export interface ModelDetail extends NodeRef {
  description: string | null
  tags: string[]
  schema_name: string | null
  database: string | null
  alias: string | null
  original_file_path: string | null
  execution_mode: string | null
  compiled_code: string | null
  raw_code: string | null
  dependencies: NodeRef[]
  dependents: NodeRef[]
  columns: ColumnInfo[]
  stats: NodeStats | null
  bigquery: BigQueryRef | null
  dbt_run_command: string | null
}

export interface SearchHit extends NodeRef {
  score: number
  matched_on: 'name' | 'description' | 'tag' | 'column'
  column: ColumnInfo | null
}

export interface SearchResponse {
  query: string
  results: SearchHit[]
}

export interface MetaResponse {
  project_names: string[]
  adapter_type: string | null
  dbt_version: string | null
  generated_at: string | null
  pipelines: string[]
  stages: string[]
  materializations: string[]
  tags: string[]
  node_count: number
  edge_count: number
  source_count: number
  model_count: number
}
