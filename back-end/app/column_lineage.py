"""Column-level lineage (feature 2.3): compiled dbt SQL -> column -> column edges.

How it works
------------
* Every model's ``compiled_code`` is parsed with **sqlglot** in the adapter's dialect
  (BigQuery for us) and *qualified against a schema* built from ``catalog.json``. The
  schema is what lets sqlglot expand ``select *``, resolve ``using (...)`` joins and
  attribute unqualified columns to the right table.
* Models are processed in topological order. A model whose columns are missing from the
  catalog (not built yet, ephemeral, ...) contributes the columns derived from its own
  SQL, so downstream models can still be resolved.
* dbt inlines ephemeral models as ``__dbt__cte__<name>`` CTEs. Those CTEs are swapped for
  a reference to the ephemeral node, so the ephemeral model stays visible as a hop.
* Each edge is classified as ``passthrough`` | ``rename`` | ``transform`` | ``aggregate``
  by looking at every expression on the path from the output column to the source column.
* Parse problems never break loading: each model gets a status (``ok`` / ``partial`` /
  ``failed`` / ``skipped``) with the reason, so the UI can be honest about coverage.

Like ``loader.py`` this module is plain Python (no FastAPI / Pydantic). The resulting
``ColumnLineageIndex`` does not care where edges come from, so another provider (dbt
Fusion's ``column_lineage`` output, OpenLineage events) could fill it later.
"""

from __future__ import annotations

import logging
from collections import deque
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Literal

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError
from sqlglot.lineage import Node, lineage
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import build_scope

from .loader import LineageGraph, LineageNode

log = logging.getLogger(__name__)

EdgeKind = Literal["passthrough", "rename", "transform", "aggregate"]
ModelStatus = Literal["ok", "partial", "failed", "skipped"]
Direction = Literal["up", "down", "both"]

EPHEMERAL_CTE_PREFIX = "__dbt__cte__"
MAX_EXPRESSION_CHARS = 240
_KIND_RANK: dict[str, int] = {"passthrough": 0, "rename": 1, "transform": 2, "aggregate": 3}

# dbt adapter_type -> sqlglot dialect (only where the names differ)
_DIALECTS: dict[str, str] = {
    "sqlserver": "tsql",
    "fabric": "tsql",
    "synapse": "tsql",
    "databricks": "databricks",
    "spark": "spark",
}


def dialect_for(adapter_type: str | None) -> str | None:
    if not adapter_type:
        return None
    name = adapter_type.lower()
    name = _DIALECTS.get(name, name)
    try:
        sqlglot.Dialect.get_or_raise(name)
    except ValueError:
        return None
    return name


# --------------------------------------------------------------------------------------
# data
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ColumnEdge:
    source_model: str
    source_column: str
    target_model: str
    target_column: str
    kind: EdgeKind
    expression: str | None = None

    @property
    def id(self) -> str:
        return f"{self.source_model}.{self.source_column}->{self.target_model}.{self.target_column}"


@dataclass
class ModelLineage:
    model_id: str
    status: ModelStatus
    error: str | None = None
    warnings: list[str] = field(default_factory=list)


@dataclass
class TraceResult:
    root: tuple[str, str]
    nodes: dict[tuple[str, str], int]  # (model_id, column) -> hop distance from root
    edges: list[ColumnEdge]


@dataclass
class ColumnLineageIndex:
    edges: list[ColumnEdge] = field(default_factory=list)
    models: dict[str, ModelLineage] = field(default_factory=dict)
    upstream: dict[tuple[str, str], list[ColumnEdge]] = field(default_factory=dict)
    downstream: dict[tuple[str, str], list[ColumnEdge]] = field(default_factory=dict)
    dialect: str | None = None

    def add(self, edge: ColumnEdge) -> None:
        self.edges.append(edge)
        self.upstream.setdefault((edge.target_model, edge.target_column), []).append(edge)
        self.downstream.setdefault((edge.source_model, edge.source_column), []).append(edge)

    @property
    def coverage(self) -> float:
        """Share of parseable models (``ok`` or ``partial``) among models that have SQL."""
        considered = [m for m in self.models.values() if m.status != "skipped"]
        if not considered:
            return 0.0
        return sum(1 for m in considered if m.status in ("ok", "partial")) / len(considered)

    def counts(self, model_id: str, column: str) -> tuple[int, int]:
        key = (model_id, column)
        return len(self.upstream.get(key, [])), len(self.downstream.get(key, []))

    def trace(
        self,
        model_id: str,
        column: str,
        direction: Direction = "both",
        depth: int | None = None,
    ) -> TraceResult:
        """BFS over the column graph, like the frontend's focus-mode closure."""
        root = (model_id, column)
        nodes: dict[tuple[str, str], int] = {root: 0}
        edges: dict[str, ColumnEdge] = {}

        walks: list[tuple[dict[tuple[str, str], list[ColumnEdge]], bool]] = []
        if direction in ("up", "both"):
            walks.append((self.upstream, True))
        if direction in ("down", "both"):
            walks.append((self.downstream, False))

        for adjacency, going_up in walks:
            seen = {root}
            queue: deque[tuple[tuple[str, str], int]] = deque([(root, 0)])
            while queue:
                key, hops = queue.popleft()
                if depth is not None and hops >= depth:
                    continue
                for edge in adjacency.get(key, []):
                    edges[edge.id] = edge
                    nxt = (
                        (edge.source_model, edge.source_column)
                        if going_up
                        else (edge.target_model, edge.target_column)
                    )
                    if nxt in seen:
                        continue
                    seen.add(nxt)
                    nodes.setdefault(nxt, hops + 1)
                    queue.append((nxt, hops + 1))

        return TraceResult(root=root, nodes=nodes, edges=list(edges.values()))


# --------------------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------------------


def _norm(value: str | None) -> str:
    return (value or "").strip('`"').lower()


def _table_name(node: LineageNode) -> str:
    return node.alias or node.name.split(".")[-1]


def _topological(graph: LineageGraph) -> list[LineageNode]:
    indegree = {nid: len(n.depends_on) for nid, n in graph.nodes.items()}
    queue = deque(sorted(nid for nid, d in indegree.items() if d == 0))
    ordered: list[LineageNode] = []
    while queue:
        nid = queue.popleft()
        ordered.append(graph.nodes[nid])
        for child in graph.nodes[nid].dependents:
            indegree[child] -= 1
            if indegree[child] == 0:
                queue.append(child)
    # cycles should not exist in dbt, but never drop a node because of one
    done = {n.id for n in ordered}
    leftover = [n for nid, n in graph.nodes.items() if nid not in done]
    return ordered + leftover


class _Builder:
    def __init__(self, graph: LineageGraph, dialect: str | None) -> None:
        self.graph = graph
        self.dialect = dialect
        self.index = ColumnLineageIndex(dialect=dialect)
        # (database, schema, table) -> node id, all lowercased
        self.relations: dict[tuple[str, str, str], str] = {}
        self.relations_no_db: dict[tuple[str, str], str] = {}
        self.ephemerals: dict[str, LineageNode] = {}
        # catalog-cased column names per node, keyed by lowercase name
        self.columns: dict[str, dict[str, str]] = {}
        self.schema: dict[str, dict[str, dict[str, dict[str, str]]]] = {}

        for node in graph.nodes.values():
            db, sch, tbl = _norm(node.database), _norm(node.schema_name), _norm(_table_name(node))
            self.relations[(db, sch, tbl)] = node.id
            self.relations_no_db.setdefault((sch, tbl), node.id)
            if node.materialization == "ephemeral":
                self.ephemerals[_norm(node.name)] = node
            self._register_columns(node, {c.name: c.type for c in node.columns})

    # ------------------------------------------------------------------ schema
    def _safe_type(self, type_: str | None) -> str:
        if not type_:
            return "UNKNOWN"
        try:
            exp.DataType.build(type_, dialect=self.dialect)
        except (SqlglotError, ValueError):
            return "UNKNOWN"
        return type_

    def _register_columns(self, node: LineageNode, columns: dict[str, str | None]) -> None:
        if not columns or not node.schema_name:
            return
        self.columns[node.id] = {name.lower(): name for name in columns}
        tables = self.schema.setdefault(node.database or "", {}).setdefault(node.schema_name, {})
        tables[_table_name(node)] = {name: self._safe_type(t) for name, t in columns.items()}

    def _column_name(self, node_id: str, column: str) -> str:
        """Return the catalog spelling of a column, falling back to sqlglot's."""
        return self.columns.get(node_id, {}).get(column.lower(), column)

    def _resolve(self, table: exp.Table) -> str | None:
        db, sch, tbl = _norm(table.catalog), _norm(table.db), _norm(table.name)
        if db:
            return self.relations.get((db, sch, tbl))
        if sch:
            return self.relations_no_db.get((sch, tbl))
        ephemeral = self.ephemerals.get(tbl)
        return ephemeral.id if ephemeral else None

    # ------------------------------------------------------------------ main loop
    def build(self) -> ColumnLineageIndex:
        for node in _topological(self.graph):
            if node.resource_type != "model":
                continue
            if not node.compiled_code or not node.compiled_code.strip():
                self.index.models[node.id] = ModelLineage(node.id, "skipped", "no compiled SQL")
                continue
            try:
                self._model(node)
            except Exception as error:  # noqa: BLE001 - one bad model must not break loading
                log.warning("column lineage failed for %s: %s", node.id, error)
                self.index.models[node.id] = ModelLineage(
                    node.id, "failed", f"{type(error).__name__}: {error}"[:500]
                )
        return self.index

    def _model(self, node: LineageNode) -> None:
        result = ModelLineage(node.id, "ok")
        self.index.models[node.id] = result

        parsed = sqlglot.parse_one(node.compiled_code or "", dialect=self.dialect)
        if not isinstance(parsed, exp.Query):
            raise TypeError(f"expected a SELECT statement, got {type(parsed).__name__}")
        parsed = self._inline_ephemerals(parsed, result)

        try:
            qualified = qualify(parsed.copy(), schema=self.schema, dialect=self.dialect)
        except SqlglotError as error:
            result.status = "partial"
            result.warnings.append(f"could not resolve every column ({error}); lineage may be incomplete")
            qualified = qualify(
                parsed.copy(), schema=self.schema, dialect=self.dialect, validate_qualify_columns=False
            )

        # models without catalog columns still feed their downstreams
        if node.id not in self.columns:
            self._register_columns(node, {name: None for name in qualified.named_selects})

        scope = build_scope(qualified)
        roots = lineage(None, qualified, schema=self.schema, dialect=self.dialect, scope=scope)
        if isinstance(roots, Node):  # single-column queries
            roots = {roots.name: roots}

        unknown: set[str] = set()
        for output, root in roots.items():
            target_column = self._column_name(node.id, output)
            best: dict[tuple[str, str], ColumnEdge] = {}
            for leaf, path in _leaf_paths(root):
                if not isinstance(leaf.source, exp.Table):
                    continue  # constants, current_date(), count(*) ...
                source_id = self._resolve(leaf.source)
                if source_id is None:
                    unknown.add(leaf.source.sql(self.dialect))
                    continue
                source_column = self._column_name(source_id, _leaf_column(leaf))
                kind, expression = self._classify(path, source_column, target_column)
                edge = ColumnEdge(source_id, source_column, node.id, target_column, kind, expression)
                key = (source_id, source_column)
                if key not in best or _KIND_RANK[kind] > _KIND_RANK[best[key].kind]:
                    best[key] = edge
            for edge in best.values():
                self.index.add(edge)

        if unknown:
            result.status = "partial"
            result.warnings.append("relations not found in the manifest: " + ", ".join(sorted(unknown)))

    # ------------------------------------------------------------------ helpers
    def _inline_ephemerals(self, query: exp.Query, result: ModelLineage) -> exp.Query:
        """Replace dbt's ``__dbt__cte__<name>`` CTEs by a reference to the ephemeral node."""
        with_ = query.find(exp.With)  # arg key is "with_" in sqlglot >= 30, "with" before
        if not with_ or with_.parent is not query:
            return query

        replacements: dict[str, LineageNode] = {}
        for cte in list(with_.expressions):
            alias = cte.alias_or_name
            if not alias.lower().startswith(EPHEMERAL_CTE_PREFIX):
                continue
            target = self.ephemerals.get(alias[len(EPHEMERAL_CTE_PREFIX) :].lower())
            if target is None or not target.schema_name:
                result.warnings.append(f"ephemeral CTE {alias} has no matching model; traced through it")
                continue
            replacements[alias.lower()] = target
            cte.pop()

        if not replacements:
            return query
        if not with_.expressions:
            with_.pop()

        def swap(node: exp.Expr) -> exp.Expr:
            if isinstance(node, exp.Table) and not node.db and node.name.lower() in replacements:
                target = replacements[node.name.lower()]
                return exp.table_(
                    _table_name(target),
                    db=target.schema_name,
                    catalog=target.database,
                    quoted=True,
                    alias=node.alias_or_name,
                )
            return node

        return query.transform(swap, copy=False)

    def _classify(
        self, path: list[Node], source_column: str, target_column: str
    ) -> tuple[EdgeKind, str | None]:
        kind: EdgeKind = "passthrough"
        expression: str | None = None
        for step in path:
            inner = step.expression.this if isinstance(step.expression, exp.Alias) else step.expression
            if not isinstance(inner, exp.Expr) or isinstance(inner, exp.Column):
                continue
            if expression is None:
                expression = inner.sql(self.dialect)[:MAX_EXPRESSION_CHARS]
            if inner.find(exp.AggFunc):
                kind = "aggregate"
            elif kind != "aggregate":
                kind = "transform"
        if kind == "passthrough" and source_column.lower() != target_column.lower():
            kind = "rename"
        return kind, expression


def _leaf_paths(root: Node) -> Iterator[tuple[Node, list[Node]]]:
    stack: list[tuple[Node, list[Node]]] = [(root, [])]
    while stack:
        node, path = stack.pop()
        if not node.downstream:
            yield node, path
            continue
        for child in node.downstream:
            stack.append((child, [*path, node]))


def _leaf_column(leaf: Node) -> str:
    try:
        column = exp.to_column(leaf.name)
    except SqlglotError:
        return leaf.name.split(".")[-1].strip('`"')
    return column.name


def build_column_lineage(graph: LineageGraph, dialect: str | None = None) -> ColumnLineageIndex:
    """Parse every model of ``graph`` and return the column-level lineage index."""
    return _Builder(graph, dialect or dialect_for(graph.adapter_type)).build()
