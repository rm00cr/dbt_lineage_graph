"""Pydantic models = the API contract v0 (keep in sync with ../contract.md and
front-end/src/api/types.ts)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Stage = Literal["src", "int", "out", "other"]
Materialization = Literal["table", "view", "incremental", "ephemeral", "source", "other"]
ResourceType = Literal["model", "source"]


class NodeRef(BaseModel):
    """Slim reference used in dependency / dependent / search lists."""

    id: str
    name: str
    stage: Stage
    materialization: Materialization
    pipeline: str
    resource_type: ResourceType


class GraphNode(NodeRef):
    """Node as rendered on the canvas — intentionally slim."""

    schema_name: str | None = None
    database: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    column_count: int = 0
    execution_mode: str | None = None


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    cross_pipeline: bool = False


class GraphStats(BaseModel):
    node_count: int
    edge_count: int
    pipelines: list[str] = Field(default_factory=list)
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
    materialization: Materialization
    pipeline: str
    resource_type: ResourceType
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


class MetaResponse(BaseModel):
    project_names: list[str]
    adapter_type: str | None = None
    dbt_version: str | None = None
    generated_at: str | None = None
    pipelines: list[str]
    stages: list[str]
    materializations: list[str]
    tags: list[str]
    node_count: int
    edge_count: int
    source_count: int
    model_count: int


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    artifacts: list[str]
    catalog_loaded: bool
    node_count: int
