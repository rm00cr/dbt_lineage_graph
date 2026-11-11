"""Pydantic models = the API contract v0 (keep in sync with ../contract.md and
front-end/src/api/types.ts)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

# a layer name from pipelines.yaml `layers` (default: src / int / out), or "other"
Stage = str
# what a layer does, from its position: src = first (imports), out = last (public outputs)
StageRole = Literal["src", "int", "out", "other"]
Materialization = Literal["table", "view", "incremental", "ephemeral", "source", "test", "other"]
ResourceType = Literal["model", "source", "test"]
ChangeStatus = Literal["added", "removed", "modified", "unchanged"]


class NodeRef(BaseModel):
    """Slim reference used in dependency / dependent / search lists."""

    id: str
    name: str
    stage: Stage
    role: StageRole = "other"
    materialization: Materialization
    pipeline: str
    resource_type: ResourceType


class TestInfo(BaseModel):
    """A dbt test (incl. dq checks) attached to a node it reads."""

    name: str
    kind: Literal["generic", "singular"]
    test_name: str | None = Field(default=None, description="generic tests: not_null, unique, ...")
    column: str | None = None
    severity: str = "error"
    description: str | None = None


class GraphNode(NodeRef):
    """Node as rendered on the canvas — intentionally slim."""

    group: str | None = None  # dbt group = domain row in the stage-lanes layout
    folder: str | None = None  # model sub-folder of the stage; sources: their consumers' folder
    schema_name: str | None = None
    database: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    column_count: int = 0
    execution_mode: str | None = None
    tests: list[TestInfo] = Field(default_factory=list)
    # only set in a state comparison (POST /api/diff), null on the normal graph
    change: ChangeStatus | None = None
    # stacked execution modes: the selected modes of this node's pipeline containing it,
    # front mode first; null when its pipeline shows a single mode
    modes: list[str] | None = None
    front: bool = True  # false: a ghost, only in back modes
    sql_differs: list[str] = Field(default_factory=list)  # back modes with other SQL


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    cross_pipeline: bool = False
    change: ChangeStatus | None = None
    front: bool = True  # false: the edge exists only in a back mode of a stacked pipeline


class GraphStats(BaseModel):
    node_count: int
    edge_count: int
    pipelines: list[str] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)
    stages: list[str] = Field(default_factory=list)
    materializations: list[str] = Field(default_factory=list)


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    stats: GraphStats


class ColumnInfo(BaseModel):
    name: str
    type: str | None = None
    description: str | None = None
    index: int | None = None
    # direct column-lineage edges (2.3); null when the model could not be parsed
    upstream_count: int | None = None
    downstream_count: int | None = None


class NodeStats(BaseModel):
    row_count: int | None = None
    size_bytes: int | None = None


class BigQueryRef(BaseModel):
    project: str
    dataset: str
    table: str
    console_url: str
    query_url: str | None = None


class ModelDetail(BaseModel):
    id: str
    name: str
    stage: Stage
    role: StageRole = "other"
    materialization: Materialization
    pipeline: str
    resource_type: ResourceType
    group: str | None = None
    folder: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    schema_name: str | None = None
    database: str | None = None
    alias: str | None = None
    original_file_path: str | None = None
    execution_mode: str | None = None
    compiled_code: str | None = None
    raw_code: str | None = None
    dependencies: list[NodeRef] = Field(default_factory=list)
    dependents: list[NodeRef] = Field(default_factory=list)
    columns: list[ColumnInfo] = Field(default_factory=list)
    tests: list[TestInfo] = Field(default_factory=list)
    stats: NodeStats | None = None
    bigquery: BigQueryRef | None = None
    dbt_run_command: str | None = None


class SearchHit(NodeRef):
    score: float
    matched_on: Literal["name", "description", "tag", "column"] = "name"
    column: ColumnInfo | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SearchHit]


class LayerInfo(BaseModel):
    """A layer (stage) from pipelines.yaml `layers`."""

    name: str
    label: str
    role: StageRole


class MetaResponse(BaseModel):
    project_names: list[str]
    adapter_type: str | None = None
    dbt_version: str | None = None
    generated_at: str | None = None
    pipelines: list[str]
    groups: list[str] = Field(default_factory=list)
    stages: list[str]
    # every configured layer once, in flow order (stages lists only the ones with nodes)
    layers: list[LayerInfo] = Field(default_factory=list)
    materializations: list[str]
    tags: list[str]
    node_count: int
    edge_count: int
    source_count: int
    model_count: int


class GenerationJobInfo(BaseModel):
    """A background `dbt docs generate` run (GET /api/jobs)."""

    id: str
    pipeline: str
    mode: str | None = None  # null: a pipeline without execution modes
    trigger: Literal["startup", "user", "mode-switch"]
    status: Literal["queued", "running", "done", "failed"]
    started_at: datetime
    finished_at: datetime | None = None
    error: str | None = None
    command: str
    log_tail: list[str] = Field(default_factory=list)  # last lines of dbt output, live while running


class PipelineModeInfo(BaseModel):
    """One execution mode of a pipeline: a named combination of dbt vars."""

    name: str
    vars: dict[str, Any] = Field(default_factory=dict)
    available: bool  # its manifest.json is on disk
    generated_at: str | None = None  # manifest metadata.generated_at
    manifest: str
    job: GenerationJobInfo | None = None  # latest generation of this mode


class PipelineInfo(BaseModel):
    """A configured pipeline and - if it has execution modes - which one is shown."""

    name: str
    layers: list[str] = Field(default_factory=list)  # its stages, in flow order
    active_mode: str | None = None  # null: the pipeline has no execution modes = the front mode
    stacked_modes: list[str] = Field(default_factory=list)  # selected back modes, shown behind
    pending_mode: str | None = None  # being generated; shown once done
    available: bool  # the shown artifacts are on disk
    generated_at: str | None = None
    can_generate: bool = False  # has a project_dir: dbt can (re)generate its artifacts
    job: GenerationJobInfo | None = None  # latest generation (pipelines without modes)
    modes: list[PipelineModeInfo] = Field(default_factory=list)


class GenerateRequest(BaseModel):
    mode: str | None = None  # default: the shown mode


class SetModeRequest(BaseModel):
    mode: str


class SetModesRequest(BaseModel):
    selected: list[str] = Field(min_length=1, description="modes to show, stacked")
    front: str = Field(description="the selected mode shown in front")


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    artifacts: list[str]
    catalog_loaded: bool
    node_count: int


# ----------------------------------------------------------------- column lineage (2.3)

ColumnEdgeKind = Literal["passthrough", "rename", "unnest", "transform", "aggregate"]
ModelLineageStatus = Literal["ok", "partial", "failed", "skipped"]


class ColumnNode(BaseModel):
    model_id: str
    model_name: str
    column: str
    type: str | None = None
    distance: int = Field(description="hops from the traced column (0 = the root)")


class ColumnEdge(BaseModel):
    id: str
    source_model: str
    source_column: str
    target_model: str
    target_column: str
    kind: ColumnEdgeKind
    expression: str | None = None


class ColumnLineageResponse(BaseModel):
    root: ColumnNode
    direction: Literal["up", "down", "both"]
    depth: int | None = None
    nodes: list[ColumnNode]
    edges: list[ColumnEdge]
    warnings: list[str] = Field(default_factory=list)


class ModelLineageInfo(BaseModel):
    model_id: str
    model_name: str
    status: ModelLineageStatus
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)


class LineageStatusResponse(BaseModel):
    dialect: str | None = None
    coverage: float = Field(description="share of models with SQL that parsed (ok or partial)")
    edge_count: int
    counts: dict[str, int]
    models: list[ModelLineageInfo]


# ----------------------------------------------------------------- state comparison (diff)

ColumnChangeKind = Literal["added", "removed", "type_changed"]


class FieldChange(BaseModel):
    field: str
    base: str | None = None
    head: str | None = None


class ColumnChange(BaseModel):
    name: str
    change: ColumnChangeKind
    base_type: str | None = None
    head_type: str | None = None


class NodeChange(BaseModel):
    """What changed on one node. Only present for added / removed / modified nodes."""

    id: str
    name: str
    status: ChangeStatus
    fields: list[FieldChange] = Field(default_factory=list)
    columns: list[ColumnChange] = Field(default_factory=list)
    code_changed: bool = False
    code_diff: str | None = Field(default=None, description="unified diff of raw_code")
    upstream_added: list[NodeRef] = Field(default_factory=list)
    upstream_removed: list[NodeRef] = Field(default_factory=list)


class StateInfo(BaseModel):
    label: str
    project_names: list[str]
    dbt_version: str | None = None
    generated_at: str | None = None
    catalog_loaded: bool
    node_count: int


class DiffSummary(BaseModel):
    added: int
    removed: int
    modified: int
    unchanged: int
    edges_added: int
    edges_removed: int


class DiffResponse(BaseModel):
    state_id: str = Field(description="pass as ?state= to /api/model/{id} for the head version")
    pipeline: str = Field(description="the pipeline the upload replaced (or adds, if new)")
    base: StateInfo
    head: StateInfo
    summary: DiffSummary
    columns_compared: bool
    graph: GraphResponse
    changes: list[NodeChange]
    warnings: list[str] = Field(default_factory=list)
