"""GraphService: turns the internal lineage graph into contract-v0 responses."""

from __future__ import annotations

import json
import uuid
from collections import OrderedDict
from collections.abc import Iterable
from typing import Any
from urllib.parse import quote, urlencode

from .column_lineage import ColumnLineageIndex, Direction, build_column_lineage
from .config import STAGE_ORDER, Settings
from .diff import GraphDiff, diff_graphs
from .loader import LineageGraph, LineageNode, load_graph, load_graph_from_artifacts
from .schemas import (
    BigQueryRef,
    ChangeStatus,
    ColumnChange,
    ColumnEdge,
    ColumnInfo,
    ColumnLineageResponse,
    ColumnNode,
    DiffResponse,
    DiffSummary,
    FieldChange,
    GraphEdge,
    GraphNode,
    GraphResponse,
    GraphStats,
    HealthResponse,
    LineageStatusResponse,
    MetaResponse,
    ModelDetail,
    ModelLineageInfo,
    NodeChange,
    NodeRef,
    NodeStats,
    SearchHit,
    SearchResponse,
    StateInfo,
)
from .search import score_name, score_substring

BQ_CONSOLE = "https://console.cloud.google.com/bigquery"
MAX_QUERY_DEEPLINK_CHARS = 7000
# uploaded comparison states kept in memory (a real manifest can be big, keep this small)
MAX_COMPARE_STATES = 3
MATERIALIZATION_ORDER = ["source", "view", "table", "incremental", "ephemeral", "other"]


class ArtifactError(ValueError):
    """An uploaded file is not a usable dbt artifact (-> HTTP 422)."""


class UnknownStateError(KeyError):
    """A ``state`` id that is not (or no longer) held in memory (-> HTTP 404)."""


class GraphService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.graph: LineageGraph = load_graph(settings.artifacts)
        self.column_lineage: ColumnLineageIndex = build_column_lineage(self.graph)
        # comparison states (POST /api/diff): state_id -> head graph, oldest first
        self.states: OrderedDict[str, LineageGraph] = OrderedDict()

    # ------------------------------------------------------------------ lifecycle
    def reload(self) -> LineageGraph:
        """Re-read the artifacts from disk (handy when a fresh dbt run just finished)."""
        self.graph = load_graph(self.settings.artifacts)
        self.column_lineage = build_column_lineage(self.graph)
        return self.graph

    # ------------------------------------------------------------------ health / meta
    def health(self) -> HealthResponse:
        return HealthResponse(
            status="ok" if self.graph.nodes else "degraded",
            artifacts=self.graph.artifacts,
            catalog_loaded=self.graph.catalog_loaded,
            node_count=len(self.graph.nodes),
        )

    def meta(self) -> MetaResponse:
        nodes = self.graph.nodes.values()
        return MetaResponse(
            project_names=self.graph.project_names,
            adapter_type=self.graph.adapter_type,
            dbt_version=self.graph.dbt_version,
            generated_at=self.graph.generated_at,
            pipelines=self.graph.pipelines,
            groups=self.graph.groups,
            stages=self.graph.stages,
            materializations=self.graph.materializations,
            tags=self.graph.tags,
            node_count=len(self.graph.nodes),
            edge_count=len(self.graph.edges),
            source_count=sum(1 for n in nodes if n.resource_type == "source"),
            model_count=sum(1 for n in self.graph.nodes.values() if n.resource_type == "model"),
        )

    # ------------------------------------------------------------------ graph
    def graph_response(
        self,
        *,
        pipelines: list[str] | None = None,
        stages: list[str] | None = None,
        include_sources: bool = True,
    ) -> GraphResponse:
        selected: dict[str, LineageNode] = {}
        for node in self.graph.nodes.values():
            if pipelines and node.pipeline not in pipelines:
                continue
            if stages and node.stage not in stages:
                continue
            if not include_sources and node.resource_type == "source":
                continue
            selected[node.id] = node

        return self._build_graph(selected, self.graph.edges)

    def _build_graph(
        self,
        selected: dict[str, LineageNode],
        all_edges: Iterable[tuple[str, str]],
        node_change: dict[str, ChangeStatus] | None = None,
        edge_change: dict[tuple[str, str], ChangeStatus] | None = None,
    ) -> GraphResponse:
        nodes = [self._graph_node(n) for n in selected.values()]
        if node_change is not None:
            for node in nodes:
                node.change = node_change.get(node.id, "unchanged")
        nodes.sort(key=lambda n: (n.pipeline, n.stage, n.name))

        edges = [
            GraphEdge(
                id=f"{source}->{target}",
                source=source,
                target=target,
                cross_pipeline=selected[source].pipeline != selected[target].pipeline,
                change=edge_change.get((source, target)) if edge_change is not None else None,
            )
            for source, target in all_edges
            if source in selected and target in selected
        ]

        return GraphResponse(
            nodes=nodes,
            edges=edges,
            stats=GraphStats(
                node_count=len(nodes),
                edge_count=len(edges),
                pipelines=sorted({n.pipeline for n in nodes}),
                groups=sorted({n.group for n in nodes if n.group}),
                stages=[s for s in STAGE_ORDER if any(n.stage == s for n in nodes)],
                materializations=[m for m in MATERIALIZATION_ORDER if any(n.materialization == m for n in nodes)],
            ),
        )

    # ------------------------------------------------------------------ detail
    def model_detail(self, node_id: str, state: str | None = None) -> ModelDetail | None:
        """Detail of one node. With ``state`` it is read from that comparison state, falling
        back to the running graph for nodes the state does not have (removed ones)."""
        graph = self.graph
        if state:
            head = self.get_state(state)
            if (head.get(node_id) or self._find_by_name(node_id, head)) is not None:
                graph = head
        node = graph.get(node_id) or self._find_by_name(node_id, graph)
        if node is None:
            return None
        # column lineage is only built for the running graph
        with_lineage = graph is self.graph

        return ModelDetail(
            id=node.id,
            name=node.name,
            stage=node.stage,
            materialization=node.materialization,
            pipeline=node.pipeline,
            resource_type=node.resource_type,
            group=node.group,
            description=node.description,
            tags=node.tags,
            schema_name=node.schema_name,
            database=node.database,
            alias=node.alias,
            original_file_path=node.original_file_path,
            execution_mode=node.execution_mode,
            compiled_code=node.compiled_code,
            raw_code=node.raw_code,
            dependencies=[self._node_ref(i, graph) for i in node.depends_on],
            dependents=[self._node_ref(i, graph) for i in node.dependents],
            columns=[
                self._column_info(node, c.name, c.type, c.description, c.index, with_lineage=with_lineage)
                for c in node.columns
            ],
            stats=NodeStats(row_count=node.row_count, size_bytes=node.size_bytes),
            bigquery=self._bigquery_ref(node),
            dbt_run_command=self._dbt_run_command(node),
        )

    # ------------------------------------------------------------------ column lineage (2.3)
    def column_lineage_trace(
        self,
        model_id: str,
        column: str,
        direction: Direction = "both",
        depth: int | None = None,
    ) -> ColumnLineageResponse | None:
        """Trace one column. ``None`` if the model or the column is unknown."""
        node = self.graph.get(model_id) or self._find_by_name(model_id)
        if node is None:
            return None
        index = self.column_lineage
        known = {c.name.lower(): c.name for c in node.columns}
        for m, c in [*index.upstream, *index.downstream]:
            if m == node.id:
                known.setdefault(c.lower(), c)
        resolved = known.get(column.lower())
        if resolved is None:
            return None

        result = index.trace(node.id, resolved, direction, depth)
        warnings: list[str] = []
        for model in sorted({m for m, _ in result.nodes}):
            info = index.models.get(model)
            if info and info.status in ("partial", "failed"):
                reason = info.error or "; ".join(info.warnings)
                warnings.append(f"{self.graph.nodes[model].name}: lineage {info.status} - {reason}")

        nodes = [self._column_node(m, c, d) for (m, c), d in result.nodes.items()]
        nodes.sort(key=lambda n: (n.distance, n.model_name, n.column))
        return ColumnLineageResponse(
            root=self._column_node(node.id, resolved, 0),
            direction=direction,
            depth=depth,
            nodes=nodes,
            edges=[
                ColumnEdge(
                    id=e.id,
                    source_model=e.source_model,
                    source_column=e.source_column,
                    target_model=e.target_model,
                    target_column=e.target_column,
                    kind=e.kind,
                    expression=e.expression,
                )
                for e in result.edges
            ],
            warnings=warnings,
        )

    def lineage_status(self) -> LineageStatusResponse:
        index = self.column_lineage
        counts = {"ok": 0, "partial": 0, "failed": 0, "skipped": 0}
        models: list[ModelLineageInfo] = []
        for info in index.models.values():
            counts[info.status] += 1
            models.append(
                ModelLineageInfo(
                    model_id=info.model_id,
                    model_name=self.graph.nodes[info.model_id].name,
                    status=info.status,
                    error=info.error,
                    warnings=info.warnings,
                )
            )
        order = {"failed": 0, "partial": 1, "skipped": 2, "ok": 3}
        models.sort(key=lambda m: (order[m.status], m.model_name))
        return LineageStatusResponse(
            dialect=index.dialect,
            coverage=round(index.coverage, 4),
            edge_count=len(index.edges),
            counts=counts,
            models=models,
        )

    # ------------------------------------------------------------------ state comparison
    def compare(
        self,
        manifest: bytes,
        catalog: bytes | None = None,
        label: str = "uploaded state",
    ) -> DiffResponse:
        """Compare the running graph (base) with another state of the project (head).

        The head graph is kept in memory under the returned ``state_id`` so the overlay can
        load the head version of a node (``/api/model/{id}?state=...``).
        """
        manifest_data = _parse_artifact(manifest, "manifest.json")
        if not isinstance(manifest_data.get("nodes"), dict):
            raise ArtifactError("manifest.json has no 'nodes': is this a dbt manifest?")
        catalog_data = _parse_artifact(catalog, "catalog.json") if catalog else None
        if catalog_data is not None and not isinstance(catalog_data.get("nodes"), dict):
            raise ArtifactError("catalog.json has no 'nodes': is this a dbt catalog?")

        head = load_graph_from_artifacts([(manifest_data, catalog_data)], label=label)
        if not head.nodes:
            raise ArtifactError("manifest.json contains no models or sources")

        state_id = uuid.uuid4().hex[:12]
        self.states[state_id] = head
        while len(self.states) > MAX_COMPARE_STATES:
            self.states.popitem(last=False)
        return self._diff_response(state_id, head, diff_graphs(self.graph, head), label)

    def get_state(self, state_id: str) -> LineageGraph:
        try:
            return self.states[state_id]
        except KeyError:
            raise UnknownStateError(state_id) from None

    def _diff_response(self, state_id: str, head: LineageGraph, diff: GraphDiff, label: str) -> DiffResponse:
        base = self.graph
        # removed nodes come from base, everything else from head (its current shape)
        merged: dict[str, LineageNode] = {
            node_id: head.nodes.get(node_id) or base.nodes[node_id] for node_id in diff.nodes
        }

        def lookup(node_id: str) -> LineageGraph:
            return head if node_id in head.nodes else base

        def ref(node_id: str) -> NodeRef:
            return self._node_ref(node_id, lookup(node_id))

        changes: list[NodeChange] = []
        for node_diff in diff.nodes.values():
            if node_diff.status == "unchanged":
                continue
            changes.append(
                NodeChange(
                    id=node_diff.id,
                    name=merged[node_diff.id].name,
                    status=node_diff.status,
                    fields=[FieldChange(field=f.field, base=f.base, head=f.head) for f in node_diff.fields],
                    columns=[
                        ColumnChange(name=c.name, change=c.change, base_type=c.base_type, head_type=c.head_type)
                        for c in node_diff.columns
                    ],
                    code_changed=node_diff.code_changed,
                    code_diff=node_diff.code_diff,
                    upstream_added=[ref(i) for i in node_diff.upstream_added],
                    upstream_removed=[ref(i) for i in node_diff.upstream_removed],
                )
            )
        order = {"added": 0, "modified": 1, "removed": 2}
        changes.sort(key=lambda c: (order[c.status], c.name))

        return DiffResponse(
            state_id=state_id,
            base=_state_info("running state", base),
            head=_state_info(label, head),
            summary=DiffSummary(
                added=diff.count("added"),
                removed=diff.count("removed"),
                modified=diff.count("modified"),
                unchanged=diff.count("unchanged"),
                edges_added=diff.edge_count("added"),
                edges_removed=diff.edge_count("removed"),
            ),
            columns_compared=diff.columns_compared,
            graph=self._build_graph(
                merged,
                sorted(diff.edges),
                node_change={i: d.status for i, d in diff.nodes.items()},
                edge_change=diff.edges,
            ),
            changes=changes,
            warnings=diff.warnings,
        )

    # ------------------------------------------------------------------ search
    def search_models(self, query: str, limit: int = 20) -> SearchResponse:
        query = (query or "").strip()
        if not query:
            return SearchResponse(query=query, results=[])

        hits: list[SearchHit] = []
        for node in self.graph.nodes.values():
            name_score = score_name(query, node.name)
            best = (name_score, "name")

            for tag in node.tags:
                tag_score = score_name(query, tag) * 0.8
                if tag_score > best[0]:
                    best = (tag_score, "tag")

            if node.description:
                desc_score = score_substring(query, node.description) * 0.6
                if desc_score > best[0]:
                    best = (desc_score, "description")

            if best[0] >= 0.45:
                hits.append(
                    SearchHit(
                        **self._node_ref(node.id).model_dump(),
                        score=round(best[0], 4),
                        matched_on=best[1],  # type: ignore[arg-type]
                    )
                )

        hits.sort(key=lambda h: (-h.score, len(h.name), h.name))
        return SearchResponse(query=query, results=hits[:limit])

    def search_columns(self, query: str, limit: int = 50) -> SearchResponse:
        query = (query or "").strip()
        if not query:
            return SearchResponse(query=query, results=[])

        hits: list[SearchHit] = []
        for node in self.graph.nodes.values():
            for column in node.columns:
                score = score_name(query, column.name)
                if score < 0.5:
                    continue
                hits.append(
                    SearchHit(
                        **self._node_ref(node.id).model_dump(),
                        score=round(score, 4),
                        matched_on="column",
                        column=self._column_info(
                            node, column.name, column.type, column.description, column.index
                        ),
                    )
                )

        hits.sort(key=lambda h: (-h.score, h.name, h.column.name if h.column else ""))
        return SearchResponse(query=query, results=hits[:limit])

    # ------------------------------------------------------------------ internals
    def _column_info(
        self,
        node: LineageNode,
        name: str,
        type_: str | None,
        description: str | None,
        index: int | None,
        *,
        with_lineage: bool = True,
    ) -> ColumnInfo:
        upstream = downstream = None
        status = self.column_lineage.models.get(node.id)
        if with_lineage and (node.resource_type == "source" or (status and status.status in ("ok", "partial"))):
            upstream, downstream = self.column_lineage.counts(node.id, name)
        return ColumnInfo(
            name=name,
            type=type_,
            description=description,
            index=index,
            upstream_count=upstream,
            downstream_count=downstream,
        )

    def _column_node(self, model_id: str, column: str, distance: int) -> ColumnNode:
        node = self.graph.nodes[model_id]
        type_ = next((c.type for c in node.columns if c.name.lower() == column.lower()), None)
        return ColumnNode(
            model_id=model_id, model_name=node.name, column=column, type=type_, distance=distance
        )

    def _find_by_name(self, name: str, graph: LineageGraph | None = None) -> LineageNode | None:
        lowered = name.lower()
        for node in (graph or self.graph).nodes.values():
            if node.name.lower() == lowered:
                return node
        return None

    def _graph_node(self, node: LineageNode) -> GraphNode:
        return GraphNode(
            id=node.id,
            name=node.name,
            stage=node.stage,  # type: ignore[arg-type]
            materialization=node.materialization,  # type: ignore[arg-type]
            pipeline=node.pipeline,
            resource_type=node.resource_type,  # type: ignore[arg-type]
            group=node.group,
            schema_name=node.schema_name,
            database=node.database,
            description=node.description,
            tags=node.tags,
            column_count=len(node.columns),
            execution_mode=node.execution_mode,
        )

    def _node_ref(self, node_id: str, graph: LineageGraph | None = None) -> NodeRef:
        node = (graph or self.graph).nodes[node_id]
        return NodeRef(
            id=node.id,
            name=node.name,
            stage=node.stage,  # type: ignore[arg-type]
            materialization=node.materialization,  # type: ignore[arg-type]
            pipeline=node.pipeline,
            resource_type=node.resource_type,  # type: ignore[arg-type]
        )

    def _bigquery_ref(self, node: LineageNode) -> BigQueryRef | None:
        if self.graph.adapter_type not in (None, "bigquery"):
            return None
        if node.materialization == "ephemeral":
            return None
        project = self.settings.bq_console_project or node.database
        dataset = node.schema_name
        table = node.alias or node.name.split(".")[-1]
        if not (project and dataset and table):
            return None

        # Deeplink that preselects the table in the BigQuery explorer.
        ws = f"!1m5!1m4!4m3!1s{project}!2s{dataset}!3s{table}"
        console_url = f"{BQ_CONSOLE}?{urlencode({'project': project})}&ws={quote(ws, safe='!')}"

        query_url = None
        if node.compiled_code and len(node.compiled_code) <= MAX_QUERY_DEEPLINK_CHARS:
            query_url = f"{BQ_CONSOLE}?{urlencode({'project': project, 'q': node.compiled_code})}"

        return BigQueryRef(
            project=project,
            dataset=dataset,
            table=table,
            console_url=console_url,
            query_url=query_url,
        )

    def _dbt_run_command(self, node: LineageNode) -> str | None:
        if node.resource_type != "model":
            return None
        return f"dbt run --select {node.name}"


def _parse_artifact(raw: bytes, name: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArtifactError(f"{name} is not valid JSON: {error}") from None
    if not isinstance(data, dict):
        raise ArtifactError(f"{name} must be a JSON object")
    return data


def _state_info(label: str, graph: LineageGraph) -> StateInfo:
    return StateInfo(
        label=label,
        project_names=graph.project_names,
        dbt_version=graph.dbt_version,
        generated_at=graph.generated_at,
        catalog_loaded=graph.catalog_loaded,
        node_count=len(graph.nodes),
    )
