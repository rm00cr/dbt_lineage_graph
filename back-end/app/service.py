"""GraphService: turns the internal lineage graph into contract-v0 responses."""

from __future__ import annotations

from urllib.parse import quote, urlencode

from .config import Settings
from .loader import LineageGraph, LineageNode, load_graph
from .schemas import (
    BigQueryRef,
    ColumnInfo,
    GraphEdge,
    GraphNode,
    GraphResponse,
    GraphStats,
    HealthResponse,
    MetaResponse,
    ModelDetail,
    NodeRef,
    NodeStats,
    SearchHit,
    SearchResponse,
)
from .search import score_name, score_substring

BQ_CONSOLE = "https://console.cloud.google.com/bigquery"
MAX_QUERY_DEEPLINK_CHARS = 7000


class GraphService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.graph: LineageGraph = load_graph(settings.artifacts)

    # ------------------------------------------------------------------ lifecycle
    def reload(self) -> LineageGraph:
        """Re-read the artifacts from disk (handy when a fresh dbt run just finished)."""
        self.graph = load_graph(self.settings.artifacts)
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

        nodes = [self._graph_node(n) for n in selected.values()]
        nodes.sort(key=lambda n: (n.pipeline, n.stage, n.name))

        edges = [
            GraphEdge(
                id=f"{source}->{target}",
                source=source,
                target=target,
                cross_pipeline=(
                    self.graph.nodes[source].pipeline != self.graph.nodes[target].pipeline
                ),
            )
            for source, target in self.graph.edges
            if source in selected and target in selected
        ]

        return GraphResponse(
            nodes=nodes,
            edges=edges,
            stats=GraphStats(
                node_count=len(nodes),
                edge_count=len(edges),
                pipelines=sorted({n.pipeline for n in nodes}),
                stages=[s for s in self.graph.stages if any(n.stage == s for n in nodes)],
                materializations=[
                    m for m in self.graph.materializations if any(n.materialization == m for n in nodes)
                ],
            ),
        )

    # ------------------------------------------------------------------ detail
    def model_detail(self, node_id: str) -> ModelDetail | None:
        node = self.graph.get(node_id)
        if node is None:
            node = self._find_by_name(node_id)
        if node is None:
            return None

        return ModelDetail(
            id=node.id,
            name=node.name,
            stage=node.stage,
            materialization=node.materialization,
            pipeline=node.pipeline,
            resource_type=node.resource_type,
            description=node.description,
            tags=node.tags,
            schema_name=node.schema_name,
            database=node.database,
            alias=node.alias,
            original_file_path=node.original_file_path,
            execution_mode=node.execution_mode,
            compiled_code=node.compiled_code,
            raw_code=node.raw_code,
            dependencies=[self._node_ref(i) for i in node.depends_on],
            dependents=[self._node_ref(i) for i in node.dependents],
            columns=[
                ColumnInfo(name=c.name, type=c.type, description=c.description, index=c.index)
                for c in node.columns
            ],
            stats=NodeStats(row_count=node.row_count, size_bytes=node.size_bytes),
            bigquery=self._bigquery_ref(node),
            dbt_run_command=self._dbt_run_command(node),
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
                        column=ColumnInfo(
                            name=column.name,
                            type=column.type,
                            description=column.description,
                            index=column.index,
                        ),
                    )
                )

        hits.sort(key=lambda h: (-h.score, h.name, h.column.name if h.column else ""))
        return SearchResponse(query=query, results=hits[:limit])

    # ------------------------------------------------------------------ internals
    def _find_by_name(self, name: str) -> LineageNode | None:
        lowered = name.lower()
        for node in self.graph.nodes.values():
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
            schema_name=node.schema_name,
            database=node.database,
            description=node.description,
            tags=node.tags,
            column_count=len(node.columns),
            execution_mode=node.execution_mode,
        )

    def _node_ref(self, node_id: str) -> NodeRef:
        node = self.graph.nodes[node_id]
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
