"""GraphService: turns the internal lineage graph into contract-v0 responses."""

from __future__ import annotations

import json
import re
import threading
import uuid
from collections import OrderedDict
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

from .column_lineage import ColumnLineageIndex, Direction, build_column_lineage
from .config import ArtifactPair, ExecutionMode, Layer, Settings
from .dbt_runner import DbtRunner, GenerationJob, JobTrigger
from .diff import GraphDiff, diff_graphs
from .loader import (
    LineageGraph,
    LineageNode,
    LoadedArtifacts,
    build_graph,
    load_graph,
    ordered_layers,
    read_artifacts,
)
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
    GenerationJobInfo,
    GraphEdge,
    GraphNode,
    GraphResponse,
    GraphStats,
    HealthResponse,
    LayerInfo,
    LineageStatusResponse,
    MetaResponse,
    ModelDetail,
    ModelLineageInfo,
    NodeChange,
    NodeRef,
    NodeStats,
    PipelineInfo,
    PipelineModeInfo,
    SearchHit,
    SearchResponse,
    StateInfo,
)
from .search import score_name, score_substring
from .stack import ModeStack, build_stack

BQ_CONSOLE = "https://console.cloud.google.com/bigquery"
MAX_QUERY_DEEPLINK_CHARS = 7000
# uploaded comparison states kept in memory (a real manifest can be big, keep this small)
MAX_COMPARE_STATES = 3
MATERIALIZATION_ORDER = ["source", "view", "table", "incremental", "ephemeral", "other"]


class ArtifactError(ValueError):
    """An uploaded file is not a usable dbt artifact (-> HTTP 422)."""


class UnknownStateError(KeyError):
    """A ``state`` id that is not (or no longer) held in memory (-> HTTP 404)."""


class UnknownPipelineError(KeyError):
    """A pipeline or execution mode name that is not configured (-> HTTP 404)."""


class ModeUnavailableError(ValueError):
    """An execution mode whose artifacts are not on disk and cannot be generated (-> HTTP 409)."""


class GraphService:
    def __init__(self, settings: Settings, runner: DbtRunner | None = None) -> None:
        self.settings = settings
        self.runner = runner or DbtRunner()
        # pipeline name -> shown execution mode (only pipelines that have modes)
        self.active_modes: dict[str, str] = {
            pair.name: pair.default_mode or pair.modes[0].name for pair in settings.artifacts if pair.modes
        }
        # pipeline name -> mode to switch to once its artifacts are generated
        self.pending_modes: dict[str, str] = {}
        # pipeline name -> selected back modes, stacked behind the front (= active) mode
        self.stacked_modes: dict[str, list[str]] = {}
        self.stack: ModeStack | None = None
        # back-mode graphs (no column lineage needed), same keys as _cache
        self._graph_cache: dict[tuple[tuple[str, str], ...], LineageGraph] = {}
        # built graphs per combination of active modes, so switching back is instant
        self._cache: dict[tuple[tuple[str, str], ...], tuple[LineageGraph, ColumnLineageIndex]] = {}
        self._lock = threading.RLock()
        self.graph: LineageGraph
        self.column_lineage: ColumnLineageIndex
        self._activate()
        # comparison states (POST /api/diff): state_id -> head graph, oldest first
        self.states: OrderedDict[str, LineageGraph] = OrderedDict()

    # ------------------------------------------------------------------ lifecycle
    def reload(self) -> LineageGraph:
        """Re-read the artifacts from disk (handy when a fresh dbt run just finished)."""
        with self._lock:
            self._cache.clear()
            self._graph_cache.clear()
            self._activate()
            return self.graph

    def _effective_pairs(self, modes: dict[str, str] | None = None) -> list[ArtifactPair]:
        """The configured pipelines, each with the artifacts of its active execution mode
        (or of ``modes``, a full pipeline -> mode mapping)."""
        modes = self.active_modes if modes is None else modes
        return [pair.for_mode(modes[pair.name]) if pair.modes else pair for pair in self.settings.artifacts]

    def _activate(self) -> None:
        """Point ``graph``/``column_lineage`` at the active modes (built once per combination)
        and rebuild the stack of selected back modes."""
        key = tuple(sorted(self.active_modes.items()))
        built = self._cache.get(key)
        if built is None:
            graph = load_graph(self._effective_pairs())
            built = (graph, build_column_lineage(graph))
            self._cache[key] = built
        self.graph, self.column_lineage = built
        self.stack = self._build_stack()

    def _graph_for(self, modes: dict[str, str]) -> LineageGraph:
        """Graph of any combination of modes; reuses the front cache, no column lineage."""
        key = tuple(sorted(modes.items()))
        if key in self._cache:
            return self._cache[key][0]
        graph = self._graph_cache.get(key)
        if graph is None:
            graph = load_graph(self._effective_pairs(modes))
            self._graph_cache[key] = graph
        return graph

    def _build_stack(self) -> ModeStack | None:
        back: dict[tuple[str, str], LineageGraph] = {}
        for pipeline, modes in self.stacked_modes.items():
            pair = self._pair(pipeline)
            for mode in modes:
                if mode == self.active_modes.get(pipeline) or not pair.mode(mode).manifest.is_file():
                    continue  # the front mode itself / still being generated
                back[(pipeline, mode)] = self._graph_for({**self.active_modes, pipeline: mode})
        return build_stack(self.graph, self.active_modes, back) if back else None

    # ------------------------------------------------------------------ execution modes
    def pipelines_info(self) -> list[PipelineInfo]:
        return [self._pipeline_info(pair) for pair in self.settings.artifacts]

    def set_mode(self, pipeline: str, mode: str) -> PipelineInfo:
        """Show execution mode ``mode`` of ``pipeline``. Without artifacts on disk the mode is
        generated first (needs ``project_dir``) and shown once that is done."""
        pair = self._pair(pipeline)
        target = self._mode(pair, mode)
        with self._lock:
            if target.manifest.is_file():
                self.pending_modes.pop(pipeline, None)
                if self.active_modes.get(pipeline) != mode:
                    self.active_modes[pipeline] = mode
                    self._activate()
                return self._pipeline_info(pair)

            if pair.project_dir is None:
                raise ModeUnavailableError(
                    f"execution mode '{mode}' of '{pipeline}' has no artifacts yet ({target.manifest} not found) "
                    "and the pipeline has no 'project_dir' to generate them"
                )
            self.pending_modes[pipeline] = mode
            if self.runner.active_job(pipeline, mode) is None:
                self.runner.start(pair, target, "mode-switch", self._on_job_done)
        return self._pipeline_info(pair)

    def set_modes(self, pipeline: str, selected: list[str], front: str) -> PipelineInfo:
        """Show several execution modes of ``pipeline`` stacked, ``front`` in front.

        The front mode is switched like :meth:`set_mode` (generated first if needed). Back
        modes without artifacts are generated in the background and join the stack when
        done; without ``project_dir`` that is an error (ModeUnavailableError)."""
        pair = self._pair(pipeline)
        if front not in selected:
            raise ValueError(f"front mode '{front}' must be one of the selected modes")
        for mode in selected:
            self._mode(pair, mode)  # unknown -> UnknownPipelineError
        order = [m.name for m in pair.modes]
        back = sorted({m for m in selected if m != front}, key=order.index)
        missing = [m for m in back if not pair.mode(m).manifest.is_file()]
        if missing and pair.project_dir is None:
            raise ModeUnavailableError(
                f"execution mode(s) {', '.join(missing)} of '{pipeline}' have no artifacts yet "
                "and the pipeline has no 'project_dir' to generate them"
            )
        with self._lock:
            self.set_mode(pipeline, front)
            if back:
                self.stacked_modes[pipeline] = back
            else:
                self.stacked_modes.pop(pipeline, None)
            for mode in missing:
                if self.runner.active_job(pipeline, mode) is None:
                    self.runner.start(pair, pair.mode(mode), "mode-switch", self._on_job_done)
            self.stack = self._build_stack()
            return self._pipeline_info(pair)

    def generate(self, pipeline: str, mode: str | None = None, trigger: JobTrigger = "user") -> PipelineInfo:
        """Regenerate a pipeline's artifacts with dbt (for a pipeline with modes: ``mode``,
        default the shown one). Raises GenerationUnsupportedError / JobRunningError."""
        pair = self._pair(pipeline)
        target: ExecutionMode | None = None
        if pair.modes:
            target = self._mode(pair, mode or self.active_modes[pipeline])
        elif mode:
            raise UnknownPipelineError(f"pipeline '{pipeline}' has no execution modes")
        self.runner.start(pair, target, trigger, self._on_job_done)
        return self._pipeline_info(pair)

    def generate_missing(self) -> list[GenerationJob]:
        """Start generation for every shown artifact set that is not on disk (at startup)."""
        jobs: list[GenerationJob] = []
        for pair in self._effective_pairs():
            if pair.project_dir is None or pair.manifest.is_file():
                continue
            mode = pair.mode(self.active_modes[pair.name]) if pair.modes else None
            if self.runner.active_job(pair.name, mode.name if mode else None) is None:
                jobs.append(self.runner.start(pair, mode, "startup", self._on_job_done))
        return jobs

    def jobs(self) -> list[GenerationJobInfo]:
        return [_job_info(job) for job in self.runner.list()]

    def _on_job_done(self, job: GenerationJob) -> None:
        """Runs in the job's thread: pick up fresh artifacts, complete a pending switch."""
        with self._lock:
            pending = self.pending_modes.get(job.pipeline)
            if job.outcome != "done":
                if pending == job.mode:
                    self.pending_modes.pop(job.pipeline, None)  # the switch is abandoned
                return
            # drop every cached graph built from the old files of this pipeline / mode
            for cache in (self._cache, self._graph_cache):
                for key in list(cache):
                    if job.mode is None or (job.pipeline, job.mode) in key:
                        del cache[key]
            if pending is not None and pending == job.mode:
                self.pending_modes.pop(job.pipeline, None)
                self.active_modes[job.pipeline] = job.mode
            stacked = job.mode in self.stacked_modes.get(job.pipeline, [])
            if job.mode is None or self.active_modes.get(job.pipeline) == job.mode or stacked:
                self._activate()

    def _pair(self, pipeline: str) -> ArtifactPair:
        for pair in self.settings.artifacts:
            if pair.name == pipeline:
                return pair
        raise UnknownPipelineError(f"pipeline '{pipeline}' is not configured")

    @staticmethod
    def _mode(pair: ArtifactPair, mode: str) -> ExecutionMode:
        try:
            return pair.mode(mode)
        except KeyError:
            names = ", ".join(m.name for m in pair.modes) or "none"
            raise UnknownPipelineError(
                f"pipeline '{pair.name}' has no execution mode '{mode}' (modes: {names})"
            ) from None

    def _pipeline_info(self, pair: ArtifactPair) -> PipelineInfo:
        active = self.active_modes.get(pair.name)
        manifest = pair.for_mode(active).manifest if active else pair.manifest
        job = None if pair.modes else self.runner.latest(pair.name, None)
        return PipelineInfo(
            name=pair.name,
            layers=[layer.name for layer in pair.layers],
            active_mode=active,
            stacked_modes=list(self.stacked_modes.get(pair.name, [])),
            pending_mode=self.pending_modes.get(pair.name),
            available=manifest.is_file(),
            generated_at=_generated_at(manifest),
            can_generate=pair.project_dir is not None,
            job=_job_info(job) if job else None,
            modes=[self._mode_info(pair, mode) for mode in pair.modes],
        )

    def _mode_info(self, pair: ArtifactPair, mode: ExecutionMode) -> PipelineModeInfo:
        job = self.runner.latest(pair.name, mode.name)
        return PipelineModeInfo(
            name=mode.name,
            vars=mode.vars,
            available=mode.manifest.is_file(),
            generated_at=_generated_at(mode.manifest),
            manifest=str(mode.manifest),
            job=_job_info(job) if job else None,
        )

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
            layers=[LayerInfo(name=layer.name, label=layer.label, role=layer.role) for layer in self._layers()],
            materializations=self.graph.materializations,
            tags=self.graph.tags,
            node_count=len(self.graph.nodes),
            edge_count=len(self.graph.edges),
            source_count=sum(1 for n in nodes if n.resource_type == "source"),
            model_count=sum(1 for n in self.graph.nodes.values() if n.resource_type == "model"),
        )

    def _layers(self) -> list[Layer]:
        """Every layer of the configured and the loaded pipelines, in flow order."""
        return ordered_layers({**self.graph.layers, **{p.name: p.layers for p in self.settings.artifacts}})

    # ------------------------------------------------------------------ graph
    def graph_response(
        self,
        *,
        pipelines: list[str] | None = None,
        stages: list[str] | None = None,
        include_sources: bool = True,
    ) -> GraphResponse:
        stack = self.stack
        selected: dict[str, LineageNode] = {}
        for node in (stack.nodes if stack else self.graph.nodes).values():
            if pipelines and node.pipeline not in pipelines:
                continue
            if stages and node.stage not in stages:
                continue
            if not include_sources and node.resource_type == "source":
                continue
            selected[node.id] = node

        response = self._build_graph(selected, stack.edges if stack else self.graph.edges)
        if stack:
            for graph_node in response.nodes:
                graph_node.modes = stack.node_modes.get(graph_node.id)
                graph_node.front = stack.in_front(graph_node.id)
                graph_node.sql_differs = stack.sql_differs.get(graph_node.id, [])
            for edge in response.edges:
                edge.front = (edge.source, edge.target) not in stack.back_edges
            # the same order whichever mode is in front, so the layout does not move on a swap
            response.edges.sort(key=lambda e: e.id)
        return response

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
                stages=self.graph.stage_order({n.stage for n in nodes}),
                materializations=[m for m in MATERIALIZATION_ORDER if any(n.materialization == m for n in nodes)],
            ),
        )

    # ------------------------------------------------------------------ detail
    def model_detail(
        self, node_id: str, state: str | None = None, mode: str | None = None
    ) -> ModelDetail | None:
        """Detail of one node. With ``state`` it is read from that comparison state, falling
        back to the running graph for nodes the state does not have (removed ones). With
        ``mode`` from that execution mode of the node's pipeline (``None`` if the mode does
        not have the node). A ghost of a stacked back mode is read from that mode."""
        graph = self.graph
        if mode:
            return self._model_in_mode(node_id, mode)
        if self.stack and graph.get(node_id) is None:
            graph = self.stack.graph_with(node_id) or graph
        if state:
            head = self.get_state(state)
            if (head.get(node_id) or self._find_by_name(node_id, head)) is not None:
                graph = head
        node = graph.get(node_id) or self._find_by_name(node_id, graph)
        if node is None:
            return None
        return self._detail(node, graph)

    def _detail(self, node: LineageNode, graph: LineageGraph) -> ModelDetail:
        # column lineage is only built for the running (front) graph
        with_lineage = graph is self.graph
        return ModelDetail(
            id=node.id,
            name=node.name,
            stage=node.stage,
            role=node.role,  # type: ignore[arg-type]
            materialization=node.materialization,
            pipeline=node.pipeline,
            resource_type=node.resource_type,
            group=node.group,
            folder=node.folder,
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

    def _model_in_mode(self, node_id: str, mode: str) -> ModelDetail | None:
        known = (self.stack.nodes if self.stack else self.graph.nodes).get(node_id) or self._find_by_name(node_id)
        if known is None:
            return None
        pair = self._pair(known.pipeline)
        target = self._mode(pair, mode)
        if mode == self.active_modes.get(pair.name):
            return self.model_detail(known.id)
        if not target.manifest.is_file():
            raise ModeUnavailableError(f"execution mode '{mode}' of '{pair.name}' has no artifacts yet")
        graph = self._graph_for({**self.active_modes, pair.name: mode})
        node = graph.get(known.id)
        return self._detail(node, graph) if node else None

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
        pipeline: str | None = None,
    ) -> DiffResponse:
        """Compare the running graph (base) with another state of one pipeline (head).

        An upload is one dbt project = one pipeline. The head graph is the running pipelines
        with that pipeline's artifacts swapped for the upload, built by the same loader - so
        pipeline names from pipelines.yaml and the links between pipelines stay as they are,
        and only real changes show.

        Which pipeline it replaces: ``pipeline`` (its pipelines.yaml name) when given - an
        unknown name is added as a new pipeline. Without it, the running pipeline with the
        manifest's ``project_name``; since projects usually share one name (``dbt_pnc``), that
        must match exactly one pipeline, else the caller has to say which. No match at all ->
        the upload is shown as a new pipeline.

        The head graph is kept in memory under the returned ``state_id`` so the overlay can
        load the head version of a node (``/api/model/{id}?state=...``).
        """
        manifest_data = _parse_artifact(manifest, "manifest.json")
        if not isinstance(manifest_data.get("nodes"), dict):
            raise ArtifactError("manifest.json has no 'nodes': is this a dbt manifest?")
        catalog_data = _parse_artifact(catalog, "catalog.json") if catalog else None
        if catalog_data is not None and not isinstance(catalog_data.get("nodes"), dict):
            raise ArtifactError("catalog.json has no 'nodes': is this a dbt catalog?")

        has_models = any(n.get("resource_type") == "model" for n in manifest_data["nodes"].values())
        if not has_models and not manifest_data.get("sources"):
            raise ArtifactError("manifest.json contains no models or sources")

        upload = LoadedArtifacts(
            manifest=manifest_data, catalog=catalog_data, source=f"upload:{label}", layers=self.settings.layers
        )
        running = read_artifacts(self._effective_pairs())
        pipelines = ", ".join(item.name or item.project_name for item in running) or "none"
        pipeline = (pipeline or "").strip() or None

        warnings: list[str] = []
        if pipeline is not None:
            matches = [i for i, item in enumerate(running) if item.name == pipeline]
            missing = f"pipeline '{pipeline}' is not running ({pipelines}): it is shown as a new pipeline."
        else:
            matches = [i for i, item in enumerate(running) if item.project_name == upload.project_name]
            if len(matches) > 1:
                names = ", ".join(running[i].name or running[i].project_name for i in matches)
                raise ArtifactError(
                    f"dbt project '{upload.project_name}' matches several running pipelines "
                    f"({names}): choose which pipeline the upload replaces."
                )
            missing = (
                f"dbt project '{upload.project_name}' is not one of the running pipelines "
                f"({pipelines}): it is shown as a new pipeline."
            )
        position = matches[0] if matches else None

        if position is None:
            upload.name = pipeline or upload.project_name
            warnings.append(missing)
            head_items = [*running, upload]
            compare_columns = catalog_data is not None
        else:
            replaced = running[position]
            upload.name = replaced.name  # keep the pipeline name from pipelines.yaml
            upload.layers = replaced.layers
            head_items = [*running[:position], upload, *running[position + 1 :]]
            compare_columns = catalog_data is not None and replaced.catalog is not None
            if not compare_columns:
                missing = "the upload" if replaced.catalog is not None else "the running pipeline"
                warnings.append(f"No catalog.json for {missing}: column changes are not compared.")

        head = build_graph(head_items)
        diff = diff_graphs(self.graph, head, compare_columns=compare_columns)
        diff.warnings = [*warnings, *diff.warnings]

        state_id = uuid.uuid4().hex[:12]
        self.states[state_id] = head
        while len(self.states) > MAX_COMPARE_STATES:
            self.states.popitem(last=False)
        return self._diff_response(state_id, head, diff, label, upload.name or upload.project_name)

    def get_state(self, state_id: str) -> LineageGraph:
        try:
            return self.states[state_id]
        except KeyError:
            raise UnknownStateError(state_id) from None

    def _diff_response(
        self, state_id: str, head: LineageGraph, diff: GraphDiff, label: str, pipeline: str
    ) -> DiffResponse:
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
            pipeline=pipeline,
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
            stage=node.stage,
            role=node.role,  # type: ignore[arg-type]
            materialization=node.materialization,  # type: ignore[arg-type]
            pipeline=node.pipeline,
            resource_type=node.resource_type,  # type: ignore[arg-type]
            group=node.group,
            folder=node.folder,
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
            stage=node.stage,
            role=node.role,  # type: ignore[arg-type]
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


_GENERATED_AT = re.compile(rb'"generated_at"\s*:\s*"([^"]+)"')
_generated_at_cache: dict[Path, tuple[float, str | None]] = {}


def _generated_at(manifest: Path) -> str | None:
    """``metadata.generated_at`` of a manifest without parsing it: dbt writes the metadata
    block first, so the head of the file is enough. Cached by modification time."""
    try:
        mtime = manifest.stat().st_mtime
    except OSError:
        return None
    cached = _generated_at_cache.get(manifest)
    if cached and cached[0] == mtime:
        return cached[1]
    with manifest.open("rb") as fh:
        match = _GENERATED_AT.search(fh.read(16384))
    value = match.group(1).decode() if match else None
    _generated_at_cache[manifest] = (mtime, value)
    return value


def _job_info(job: GenerationJob) -> GenerationJobInfo:
    return GenerationJobInfo(
        id=job.id,
        pipeline=job.pipeline,
        mode=job.mode,
        trigger=job.trigger,
        status=job.status,
        started_at=job.started_at,
        finished_at=job.finished_at,
        error=job.error,
        command=" ".join(job.command),
        log_tail=job.log_tail(),
    )


def _state_info(label: str, graph: LineageGraph) -> StateInfo:
    return StateInfo(
        label=label,
        project_names=graph.project_names,
        dbt_version=graph.dbt_version,
        generated_at=graph.generated_at,
        catalog_loaded=graph.catalog_loaded,
        node_count=len(graph.nodes),
    )
