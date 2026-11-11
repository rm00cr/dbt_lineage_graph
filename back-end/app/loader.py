"""Loader: dbt `manifest.json` (+ `catalog.json`) -> internal lineage graph.

Design notes
------------
* One artifact pair = one pipeline = one dbt project (see `config.py`). The loader merges
  any number of them into one graph; pipelines are stitched together by table name
  (`_stitch_pipelines`), because separate manifests do not reference each other.
* Nothing here depends on FastAPI or Pydantic — it is plain data, easy to unit test.
"""

from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import STAGE_ORDER, ArtifactPair, folder_of, resolve_stage

MATERIALIZATIONS = {"table", "view", "incremental", "ephemeral", "source"}

log = logging.getLogger(__name__)


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
    # dbt `group` (models: `config.group`); sources inherit it from their consumers in _link
    group: str | None = None
    # box inside the stage: the sub-folder of a model (see config.folder_of). Sources take the
    # folder most of their consumers live in (_infer_source_folders); None = the (root) box
    folder: str | None = None
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
    def groups(self) -> list[str]:
        return sorted({n.group for n in self.nodes.values() if n.group})

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


def _pipeline_of(node: dict[str, Any], pipeline: str) -> str:
    """A pipeline is a dbt project: every node of a manifest belongs to it (named in
    pipelines.yaml, else `project_name`). `meta.pipeline` remains a per-node override."""
    meta = {**(node.get("meta") or {}), **((node.get("config") or {}).get("meta") or {})}
    override = meta.get("pipeline")
    return str(override) if override else pipeline


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


@dataclass
class LoadedArtifacts:
    """One pipeline's parsed artifacts, ready to be ingested."""

    manifest: dict[str, Any]
    catalog: dict[str, Any] | None = None
    # pipeline name from pipelines.yaml (the pipeline identity); None -> project_name
    name: str | None = None
    # where it came from, listed in /api/health
    source: str = "upload"

    @property
    def project_name(self) -> str:
        return (self.manifest.get("metadata") or {}).get("project_name") or "dbt"


def read_artifacts(pairs: Iterable[ArtifactPair]) -> list[LoadedArtifacts]:
    """Read the configured pipelines' manifest (+ catalog) files; missing ones are skipped.

    The pipeline *identity* is `pair.name` from pipelines.yaml, never the dbt
    `project_name`: in practice every project is called the same (`dbt_pnc`).
    """
    loaded: list[LoadedArtifacts] = []
    seen: set[str] = set()
    for pair in pairs:
        if pair.name in seen:
            raise ValueError(f"pipeline name {pair.name!r} is configured twice")
        seen.add(pair.name)
        if not pair.exists:
            log.warning("pipeline %r: manifest not found at %s", pair.name, pair.manifest)
            continue
        loaded.append(
            LoadedArtifacts(
                manifest=_read_json(pair.manifest),
                catalog=_read_json(pair.catalog) if pair.catalog and pair.catalog.is_file() else None,
                name=pair.name,
                source=str(pair.manifest),
            )
        )
    return loaded


def load_graph(pairs: Iterable[ArtifactPair]) -> LineageGraph:
    """Load the configured pipelines into a single merged lineage graph."""
    return build_graph(read_artifacts(pairs))


def build_graph(artifacts: Iterable[LoadedArtifacts]) -> LineageGraph:
    """Merge already parsed pipelines into one graph. Also used for states that never touch
    the disk, e.g. the running pipelines with one manifest swapped for an uploaded dev state."""
    graph = LineageGraph()
    for item in artifacts:
        if item.catalog:
            graph.catalog_loaded = True
        graph.artifacts.append(item.source)
        _ingest(graph, item.manifest, item.catalog, item.name or item.project_name)
    _link(graph)
    return graph


def _scope_id(unique_id: str, project: str, pipeline: str) -> str:
    """Node ids are scoped by pipeline, because dbt unique_ids are not unique across
    pipelines (all projects share one `project_name`):

        model.dbt_pnc.int_x        -> model.<pipeline>.int_x
        source.dbt_pnc.raw.t       -> source.<pipeline>.raw.t
        model.dbt_utils.helper     -> model.<pipeline>.dbt_utils.helper   (package nodes)
    """
    kind, _, rest = unique_id.partition(".")
    package, _, name = rest.partition(".")
    if package == project and name:
        return f"{kind}.{pipeline}.{name}"
    return f"{kind}.{pipeline}.{rest}"


def _ingest(
    graph: LineageGraph,
    manifest: dict[str, Any],
    catalog: dict[str, Any] | None,
    pipeline: str,
) -> None:
    """Add one pipeline; its nodes get pipeline-scoped ids (`_scope_id`)."""
    metadata = manifest.get("metadata") or {}
    project = (metadata.get("project_name") or "dbt")
    if project not in graph.project_names:
        graph.project_names.append(project)
    graph.adapter_type = graph.adapter_type or metadata.get("adapter_type")
    graph.dbt_version = graph.dbt_version or metadata.get("dbt_version")
    graph.generated_at = graph.generated_at or metadata.get("generated_at")

    catalog_nodes = (catalog or {}).get("nodes") or {}
    catalog_sources = (catalog or {}).get("sources") or {}

    own_ids = {*(manifest.get("nodes") or {}), *(manifest.get("sources") or {})}
    id_map = {uid: _scope_id(uid, project, pipeline) for uid in own_ids}

    # ------------------------------------------------------------------ models
    for node_id, node in (manifest.get("nodes") or {}).items():
        if node.get("resource_type") != "model":
            continue  # tests / seeds / snapshots are out of scope for v0

        catalog_entry = catalog_nodes.get(node_id)
        row_count, size_bytes = _stats_of(catalog_entry)
        config = node.get("config") or {}
        meta = {**(node.get("meta") or {}), **(config.get("meta") or {})}
        tags = sorted({*(node.get("tags") or []), *(config.get("tags") or [])})

        graph.nodes[id_map.get(node_id, node_id)] = LineageNode(
            id=id_map.get(node_id, node_id),
            name=node.get("name") or node_id.split(".")[-1],
            stage=resolve_stage(
                name=node.get("name") or "",
                resource_type="model",
                original_file_path=node.get("original_file_path") or node.get("path"),
                tags=tags,
            ),
            materialization=_materialization_of(node),
            pipeline=_pipeline_of(node, pipeline),
            resource_type="model",
            project=node.get("package_name") or project,
            group=node.get("group") or config.get("group") or None,
            folder=folder_of(node.get("original_file_path") or node.get("path")),
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
            depends_on=[id_map.get(d, d) for d in (node.get("depends_on") or {}).get("nodes") or []],
        )

    # ----------------------------------------------------------------- sources
    for node_id, node in (manifest.get("sources") or {}).items():
        catalog_entry = catalog_sources.get(node_id)
        row_count, size_bytes = _stats_of(catalog_entry)
        source_name = node.get("source_name") or ""
        identifier = node.get("identifier") or node.get("name") or ""
        display_name = f"{source_name}.{identifier}" if source_name else identifier

        graph.nodes[id_map.get(node_id, node_id)] = LineageNode(
            id=id_map.get(node_id, node_id),
            name=display_name,
            stage="src",
            materialization="source",
            pipeline=_pipeline_of(node, pipeline),
            resource_type="source",
            project=node.get("package_name") or project,
            # dbt has no groups for sources; allow an explicit `meta.group`, else inferred in _link
            group=_source_group(node),
            folder=None,  # inferred in _infer_source_folders from the consuming models
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


PASSTHROUGH_VIEW_SUFFIX = "_v"


def _stitch_pipelines(graph: LineageGraph) -> None:
    """Connect pipelines that were loaded from separate manifests.

    A pipeline reads another pipeline's output by declaring that table as a dbt *source*.
    The two manifests know nothing of each other, so the link is made here, and on the
    **table name only**: pipelines are often deployed to different GCP projects / datasets
    (and per environment), so database and schema are deliberately ignored.

    Only `out` models (a pipeline's public interface) are link targets; `src` and `int`
    models are never matched, even if their table name fits.

    A source may also read an output through a passthrough view named `{table}_v`. An exact
    name match wins; only if there is none is the `_v` suffix stripped and matched again.

    ASSUMPTION: output table names are unique across all pipelines. If a table name matches
    several outputs, the source stays unlinked and a warning is logged.

    The matched model is added to the source's `depends_on`, so the edge is
    `upstream model -> source` and is cross-pipeline by construction.
    """
    by_table: dict[str, list[LineageNode]] = defaultdict(list)
    for node in graph.nodes.values():
        if (
            node.resource_type == "model"
            and node.stage == "out"
            and node.materialization != "ephemeral"
        ):
            by_table[table_name(node).lower()].append(node)

    def outputs_named(name: str, source: LineageNode) -> list[LineageNode]:
        return [m for m in by_table.get(name, []) if m.pipeline != source.pipeline]

    for source in graph.nodes.values():
        if source.resource_type != "source":
            continue
        name = table_name(source).lower()
        candidates = outputs_named(name, source)
        if not candidates and name.endswith(PASSTHROUGH_VIEW_SUFFIX):
            candidates = outputs_named(name.removesuffix(PASSTHROUGH_VIEW_SUFFIX), source)
        if len(candidates) == 1:
            source.depends_on.append(candidates[0].id)
        elif candidates:
            log.warning(
                "source %s matches several output tables of other pipelines (%s); left unlinked",
                source.id,
                ", ".join(sorted(m.id for m in candidates)),
            )


def table_name(node: LineageNode) -> str:
    """The physical table name of a node (dbt `alias` for models, `identifier` for sources)."""
    return node.alias or node.name.split(".")[-1]


def _link(graph: LineageGraph) -> None:
    """Keep only edges between known nodes and invert them into `dependents`."""
    _stitch_pipelines(graph)
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
    _infer_source_groups(graph)
    _infer_source_folders(graph)


def _source_group(node: dict[str, Any]) -> str | None:
    meta = {**(node.get("meta") or {}), **((node.get("config") or {}).get("meta") or {})}
    group = meta.get("group")
    return str(group) if group else None


def _infer_source_groups(graph: LineageGraph) -> None:
    """Sources cannot be in a dbt group: place each ungrouped source in the group most of its
    direct consumers belong to (ties broken alphabetically), so it lands in their domain row."""
    for node in graph.nodes.values():
        if node.resource_type != "source" or node.group:
            continue
        counts = Counter(g for i in node.dependents if (g := graph.nodes[i].group))
        if counts:
            node.group = min(counts, key=lambda g: (-counts[g], g))


def _infer_source_folders(graph: LineageGraph) -> None:
    """A source takes the folder most of its direct consumers live in (ties alphabetical), so
    a raw table is drawn next to the src models that read it. Sources with no folder-bearing
    consumer stay without one."""
    for node in graph.nodes.values():
        if node.resource_type != "source" or node.folder:
            continue
        counts = Counter(f for i in node.dependents if (f := graph.nodes[i].folder))
        if counts:
            node.folder = min(counts, key=lambda f: (-counts[f], f))
