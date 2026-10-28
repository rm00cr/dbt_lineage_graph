"""Loader: dbt `manifest.json` (+ `catalog.json`) -> internal lineage graph.

Design notes
------------
* The loader accepts a *list* of artifact pairs, so loading several dbt projects and
  merging them into one graph (feature 2.4) is a config change, not a code change.
* Nothing here depends on FastAPI or Pydantic — it is plain data, easy to unit test.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import STAGE_ORDER, ArtifactPair, resolve_stage

MATERIALIZATIONS = {"table", "view", "incremental", "ephemeral", "source"}


@dataclass
class Column:
    name: str
    type: str | None = None
    description: str | None = None
    index: int | None = None


@dataclass
class LineageNode:
    id: str
    name: str
    stage: str
    materialization: str
    pipeline: str
    resource_type: str
    project: str
    schema_name: str | None = None
    database: str | None = None
    alias: str | None = None
    description: str | None = None
    tags: list[str] = field(default_factory=list)
    original_file_path: str | None = None
    execution_mode: str | None = None
    raw_code: str | None = None
    compiled_code: str | None = None
    columns: list[Column] = field(default_factory=list)
    row_count: int | None = None
    size_bytes: int | None = None
    depends_on: list[str] = field(default_factory=list)
    dependents: list[str] = field(default_factory=list)


@dataclass
class LineageGraph:
    nodes: dict[str, LineageNode] = field(default_factory=dict)
    edges: list[tuple[str, str]] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    catalog_loaded: bool = False
    project_names: list[str] = field(default_factory=list)
    adapter_type: str | None = None
    dbt_version: str | None = None
    generated_at: str | None = None

    # ---------------------------------------------------------------- convenience
    @property
    def pipelines(self) -> list[str]:
        return sorted({n.pipeline for n in self.nodes.values() if n.pipeline})

    @property
    def stages(self) -> list[str]:
        present = {n.stage for n in self.nodes.values()}
        return [s for s in STAGE_ORDER if s in present]

    @property
    def materializations(self) -> list[str]:
        order = ["source", "view", "table", "incremental", "ephemeral", "other"]
        present = {n.materialization for n in self.nodes.values()}
        return [m for m in order if m in present]

    @property
    def tags(self) -> list[str]:
        return sorted({t for n in self.nodes.values() for t in n.tags})

    def get(self, node_id: str) -> LineageNode | None:
        return self.nodes.get(node_id)


# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _pipeline_of(node: dict[str, Any], fallback_project: str) -> str:
    meta = {**(node.get("meta") or {}), **((node.get("config") or {}).get("meta") or {})}
    pipeline = meta.get("pipeline")
    if pipeline:
        return str(pipeline)

    path = (node.get("original_file_path") or node.get("path") or "").replace("\\", "/")
    segments = [s for s in path.split("/") if s]
    if segments and segments[0] in {"models", "seeds", "snapshots"} and len(segments) > 1:
        return segments[1]
    if segments and len(segments) > 1:
        return segments[0]
    return fallback_project


def _materialization_of(node: dict[str, Any]) -> str:
    value = (node.get("config") or {}).get("materialized") or node.get("materialized")
    value = (value or "").lower()
    return value if value in MATERIALIZATIONS else "other"


def _stats_of(catalog_entry: dict[str, Any] | None) -> tuple[int | None, int | None]:
    if not catalog_entry:
        return None, None
    stats = catalog_entry.get("stats") or {}

    def _value(key: str) -> int | None:
        entry = stats.get(key) or {}
        value = entry.get("value")
        if value is None:
            return None
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None

    return _value("num_rows"), _value("num_bytes")


def _merge_columns(
    manifest_columns: dict[str, Any] | None,
    catalog_entry: dict[str, Any] | None,
) -> list[Column]:
    """Catalog wins for types, manifest wins for descriptions (that is where docs live)."""
    manifest_columns = manifest_columns or {}
    catalog_columns = (catalog_entry or {}).get("columns") or {}

    merged: dict[str, Column] = {}

    for name, col in catalog_columns.items():
        merged[name] = Column(
            name=col.get("name") or name,
            type=col.get("type"),
            description=col.get("comment") or None,
            index=col.get("index"),
        )

    for name, col in manifest_columns.items():
        existing = merged.get(name)
        description = col.get("description") or (existing.description if existing else None)
        if existing:
            existing.description = description or None
        else:
            merged[name] = Column(
                name=col.get("name") or name,
                type=(col.get("data_type") or None),
                description=description or None,
                index=None,
            )

    columns = list(merged.values())
    columns.sort(key=lambda c: (c.index is None, c.index if c.index is not None else 0, c.name))
    for position, column in enumerate(columns, start=1):
        if column.index is None:
            column.index = position
    return columns


# --------------------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------------------


def load_graph(pairs: Iterable[ArtifactPair]) -> LineageGraph:
    """Load one or many dbt projects into a single merged lineage graph."""
    graph = LineageGraph()

    for pair in pairs:
        if not pair.exists:
            continue
        manifest = _read_json(pair.manifest)
        catalog = _read_json(pair.catalog) if pair.catalog and pair.catalog.is_file() else None
        if catalog:
            graph.catalog_loaded = True
        graph.artifacts.append(str(pair.manifest))
        _ingest(graph, manifest, catalog)

    _link(graph)
    return graph


def _ingest(graph: LineageGraph, manifest: dict[str, Any], catalog: dict[str, Any] | None) -> None:
    metadata = manifest.get("metadata") or {}
    project = metadata.get("project_name") or "dbt"
    if project not in graph.project_names:
        graph.project_names.append(project)
    graph.adapter_type = graph.adapter_type or metadata.get("adapter_type")
    graph.dbt_version = graph.dbt_version or metadata.get("dbt_version")
    graph.generated_at = graph.generated_at or metadata.get("generated_at")

    catalog_nodes = (catalog or {}).get("nodes") or {}
    catalog_sources = (catalog or {}).get("sources") or {}

    # ------------------------------------------------------------------ models
    for node_id, node in (manifest.get("nodes") or {}).items():
        if node.get("resource_type") != "model":
            continue  # tests / seeds / snapshots are out of scope for v0

        catalog_entry = catalog_nodes.get(node_id)
        row_count, size_bytes = _stats_of(catalog_entry)
        config = node.get("config") or {}
        meta = {**(node.get("meta") or {}), **(config.get("meta") or {})}
        tags = sorted({*(node.get("tags") or []), *(config.get("tags") or [])})

        graph.nodes[node_id] = LineageNode(
            id=node_id,
            name=node.get("name") or node_id.split(".")[-1],
            stage=resolve_stage(
                name=node.get("name") or "",
                resource_type="model",
                original_file_path=node.get("original_file_path") or node.get("path"),
                tags=tags,
            ),
            materialization=_materialization_of(node),
            pipeline=_pipeline_of(node, project),
            resource_type="model",
            project=node.get("package_name") or project,
            schema_name=node.get("schema"),
            database=node.get("database"),
            alias=node.get("alias") or node.get("name"),
            description=(node.get("description") or "").strip() or None,
            tags=tags,
            original_file_path=node.get("original_file_path") or node.get("path"),
            execution_mode=meta.get("execution_mode"),
            raw_code=node.get("raw_code") or node.get("raw_sql"),
            compiled_code=node.get("compiled_code") or node.get("compiled_sql"),
            columns=_merge_columns(node.get("columns"), catalog_entry),
            row_count=row_count,
            size_bytes=size_bytes,
            depends_on=list((node.get("depends_on") or {}).get("nodes") or []),
        )

    # ----------------------------------------------------------------- sources
    for node_id, node in (manifest.get("sources") or {}).items():
        catalog_entry = catalog_sources.get(node_id)
        row_count, size_bytes = _stats_of(catalog_entry)
        source_name = node.get("source_name") or ""
        identifier = node.get("identifier") or node.get("name") or ""
        display_name = f"{source_name}.{identifier}" if source_name else identifier

        graph.nodes[node_id] = LineageNode(
            id=node_id,
            name=display_name,
            stage="src",
            materialization="source",
            pipeline=_pipeline_of(node, project),
            resource_type="source",
            project=node.get("package_name") or project,
            schema_name=node.get("schema"),
            database=node.get("database"),
            alias=identifier,
            description=(node.get("description") or "").strip() or None,
            tags=sorted(set(node.get("tags") or [])),
            original_file_path=node.get("original_file_path") or node.get("path"),
            execution_mode=(node.get("meta") or {}).get("execution_mode"),
            columns=_merge_columns(node.get("columns"), catalog_entry),
            row_count=row_count,
            size_bytes=size_bytes,
            depends_on=[],
        )


def _link(graph: LineageGraph) -> None:
    """Keep only edges between known nodes and invert them into `dependents`."""
    edges: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for node in graph.nodes.values():
        resolved: list[str] = []
        for parent_id in node.depends_on:
            if parent_id not in graph.nodes or parent_id == node.id:
                continue
            resolved.append(parent_id)
            key = (parent_id, node.id)
            if key in seen:
                continue
            seen.add(key)
            edges.append(key)
            graph.nodes[parent_id].dependents.append(node.id)
        node.depends_on = resolved

    for node in graph.nodes.values():
        node.depends_on.sort(key=lambda i: graph.nodes[i].name)
        node.dependents.sort(key=lambda i: graph.nodes[i].name)

    graph.edges = edges
