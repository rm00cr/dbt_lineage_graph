/**
 * API contract v0 — keep in sync with ../../../contract.md and
 * ../../../back-end/app/schemas.py (Pydantic).
 */

export type Stage = 'src' | 'int' | 'out' | 'other'
export type Materialization = 'table' | 'view' | 'incremental' | 'ephemeral' | 'source' | 'other'
export type ResourceType = 'model' | 'source'
/** state comparison: how a node / edge differs between the running and the uploaded state */
export type ChangeStatus = 'added' | 'removed' | 'modified' | 'unchanged'

export interface NodeRef {
  id: string
  name: string
  stage: Stage
  materialization: Materialization
  pipeline: string
  resource_type: ResourceType
}

export interface GraphNode extends NodeRef {
  /** dbt group (domain) = row in the stage-lanes layout; sources inherit their consumers' group */
  group?: string | null
  schema_name: string | null
  database: string | null
  description: string | null
  tags: string[]
  column_count: number
  execution_mode: string | null
  /** only set in a state comparison (POST /api/diff) */
  change?: ChangeStatus | null
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  cross_pipeline: boolean
  change?: ChangeStatus | null
}

export interface GraphStats {
  node_count: number
  edge_count: number
  pipelines: string[]
  groups?: string[]
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
  /** direct column-lineage edges (2.3); null when the model could not be parsed */
  upstream_count?: number | null
  downstream_count?: number | null
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
  group?: string | null
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
  groups?: string[]
  stages: string[]
  materializations: string[]
  tags: string[]
  node_count: number
  edge_count: number
  source_count: number
  model_count: number
}

// ------------------------------------------------------------------ column lineage (2.3)

export type ColumnEdgeKind = 'passthrough' | 'rename' | 'transform' | 'aggregate'
export type TraceDirection = 'up' | 'down' | 'both'
export type ModelLineageStatus = 'ok' | 'partial' | 'failed' | 'skipped'

export interface ColumnNode {
  model_id: string
  model_name: string
  column: string
  type: string | null
  /** hops from the traced column, 0 = the root */
  distance: number
}

export interface ColumnLineageEdge {
  id: string
  source_model: string
  source_column: string
  target_model: string
  target_column: string
  kind: ColumnEdgeKind
  expression: string | null
}

export interface ColumnLineageResponse {
  root: ColumnNode
  direction: TraceDirection
  depth: number | null
  nodes: ColumnNode[]
  edges: ColumnLineageEdge[]
  warnings: string[]
}

export interface ModelLineageInfo {
  model_id: string
  model_name: string
  status: ModelLineageStatus
  error: string | null
  warnings: string[]
}

export interface LineageStatusResponse {
  dialect: string | null
  coverage: number
  edge_count: number
  counts: Record<ModelLineageStatus, number>
  models: ModelLineageInfo[]
}

// ------------------------------------------------------------------ state comparison (diff)

export type ColumnChangeKind = 'added' | 'removed' | 'type_changed'

export interface FieldChange {
  field: string
  base: string | null
  head: string | null
}

export interface ColumnChange {
  name: string
  change: ColumnChangeKind
  base_type: string | null
  head_type: string | null
}

/** what changed on one node; only present for added / removed / modified nodes */
export interface NodeChange {
  id: string
  name: string
  status: Exclude<ChangeStatus, 'unchanged'>
  fields: FieldChange[]
  columns: ColumnChange[]
  code_changed: boolean
  /** unified diff of raw_code (running -> uploaded) */
  code_diff: string | null
  upstream_added: NodeRef[]
  upstream_removed: NodeRef[]
}

export interface StateInfo {
  label: string
  project_names: string[]
  dbt_version: string | null
  generated_at: string | null
  catalog_loaded: boolean
  node_count: number
}

export interface DiffSummary {
  added: number
  removed: number
  modified: number
  unchanged: number
  edges_added: number
  edges_removed: number
}

export interface DiffResponse {
  /** pass as ?state= to /api/model/{id} to read the uploaded version of a node */
  state_id: string
  base: StateInfo
  head: StateInfo
  summary: DiffSummary
  columns_compared: boolean
  graph: GraphResponse
  changes: NodeChange[]
  warnings: string[]
}
