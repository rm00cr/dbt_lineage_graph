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

Performance
-----------
* One sqlglot ``MappingSchema`` is filled incrementally and shared by every ``qualify`` /
  ``lineage`` call. Passing a plain dict would make sqlglot re-normalise the whole schema
  twice per model, which grows with models x all columns.
* No defensive copies of the parsed SQL, and ``trim_selects=False``: trimming copies the
  whole SELECT for every lineage node, and only leaf sources (tables) are read here.
* An optional ``ColumnLineageCache`` keeps each model's result, keyed by everything that
  can change it (SQL, dialect, the columns of every relation it reads, ...). Rebuilds after
  a reload, a regenerated pipeline or a mode switch only re-parse models that changed; with
  a file path the cache also survives restarts.
* ``sqlglot[c]`` (compiled build, see pyproject.toml) speeds up parsing and lineage.

Like ``loader.py`` this module is plain Python (no FastAPI / Pydantic). The resulting
``ColumnLineageIndex`` does not care where edges come from, so another provider (dbt
Fusion's ``column_lineage`` output, OpenLineage events) could fill it later.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from collections import OrderedDict, deque
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError
from sqlglot.lineage import Node, lineage
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import build_scope
from sqlglot.schema import MappingSchema

from .loader import LineageGraph, LineageNode, table_name

log = logging.getLogger(__name__)

EdgeKind = Literal["passthrough", "rename", "transform", "aggregate"]
ModelStatus = Literal["ok", "partial", "failed", "skipped"]
Direction = Literal["up", "down", "both"]

EPHEMERAL_CTE_PREFIX = "__dbt__cte__"
MAX_EXPRESSION_CHARS = 240
# bump whenever the builder's output for the same input changes: invalidates cached results
CACHE_VERSION = 1
CACHE_MAX_ENTRIES = 100_000
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
# cache
# --------------------------------------------------------------------------------------


class ColumnLineageCache:
    """Per-model build results, keyed by a hash of every input that can change them.

    Entries are plain JSON-able dicts (see ``_Builder._model``). Least recently used entries
    are dropped beyond ``max_entries``. With ``path`` the cache is read on creation and
    written by ``save()``; a missing, unreadable or outdated file just means a cold cache.
    """

    def __init__(self, path: Path | None = None, max_entries: int = CACHE_MAX_ENTRIES) -> None:
        self.path = path
        self.max_entries = max_entries
        self.hits = 0
        self.misses = 0
        self._entries: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._dirty = False
        self._lock = threading.Lock()
        if path is not None:
            self._load(path)

    def __len__(self) -> int:
        return len(self._entries)

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self.misses += 1
                return None
            self.hits += 1
            self._entries.move_to_end(key)
            return entry

    def put(self, key: str, entry: dict[str, Any]) -> None:
        with self._lock:
            self._entries[key] = entry
            self._entries.move_to_end(key)
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)
            self._dirty = True

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._dirty = True

    def save(self) -> None:
        """Write the cache to ``path`` (atomically) if it changed since the last save."""
        if self.path is None:
            return
        with self._lock:
            if not self._dirty:
                return
            payload = {"version": _cache_version(), "entries": self._entries}
            text = json.dumps(payload, separators=(",", ":"))
            self._dirty = False
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError as error:
            log.warning("could not write the column lineage cache %s: %s", self.path, error)

    def _load(self, path: Path) -> None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as error:
            log.warning("ignoring unreadable column lineage cache %s: %s", path, error)
            return
        if not isinstance(payload, dict) or payload.get("version") != _cache_version():
            log.info("column lineage cache %s is from another version; starting cold", path)
            return
        entries = payload.get("entries")
        if isinstance(entries, dict):
            self._entries.update(entries)


def _cache_version() -> str:
    """Our format version + sqlglot's: another sqlglot may produce other lineage."""
    return f"{CACHE_VERSION}/{sqlglot.__version__}"


# --------------------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------------------


def _norm(value: str | None) -> str:
    return (value or "").strip('`"').lower()


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
    def __init__(
        self, graph: LineageGraph, dialect: str | None, cache: ColumnLineageCache | None = None
    ) -> None:
        self.graph = graph
        self.dialect = dialect
        self.cache = cache
        self.index = ColumnLineageIndex(dialect=dialect)
        # the same tables as `schema`, normalised once for sqlglot (see "Performance")
        self.mapping = MappingSchema(dialect=dialect)
        # lowercase table name -> (database, schema, table) keys in `schema`: what an
        # unqualified table reference may resolve to (part of the cache key)
        self.tables_by_name: dict[str, set[tuple[str, str, str]]] = {}
        # (database, schema, table) -> node id, all lowercased
        self.relations: dict[tuple[str, str, str], str] = {}
        self.relations_no_db: dict[tuple[str, str], str] = {}
        self.ephemerals: dict[str, LineageNode] = {}
        # catalog-cased column names per node, keyed by lowercase name
        self.columns: dict[str, dict[str, str]] = {}
        self.schema: dict[str, dict[str, dict[str, dict[str, str]]]] = {}

        for node in graph.nodes.values():
            db, sch, tbl = _norm(node.database), _norm(node.schema_name), _norm(table_name(node))
            # A pipeline importing another's output declares the very same relation as a
            # source; the importing SQL must resolve to that source, not the upstream model.
            if node.resource_type == "source" or (db, sch, tbl) not in self.relations:
                self.relations[(db, sch, tbl)] = node.id
            if node.resource_type == "source" or (sch, tbl) not in self.relations_no_db:
                self.relations_no_db[(sch, tbl)] = node.id
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
        database, table = node.database or "", table_name(node)
        tables = self.schema.setdefault(database, {}).setdefault(node.schema_name, {})
        replacing = table in tables
        tables[table] = {name: self._safe_type(t) for name, t in columns.items()}
        self.tables_by_name.setdefault(table.lower(), set()).add((database, node.schema_name, table))

        # an empty database stays a (blank) level, exactly like the nested dict
        self.mapping.add_table(
            exp.Table(
                this=exp.to_identifier(table, quoted=True),
                db=exp.to_identifier(node.schema_name, quoted=True),
                catalog=exp.Identifier(this=database, quoted=True),
            ),
            tables[table],
            dialect=self.dialect,
        )
        if replacing:
            # sqlglot caches table lookups by the referencing expression (alias and all);
            # add_table only evicts the canonical key, so drop them all on an update
            find_cache = getattr(self.mapping, "_find_cache", None)
            if isinstance(find_cache, dict):
                find_cache.clear()

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
            if node.resource_type == "source":
                self._pipeline_import(node)
                continue
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

    def _parse(self, node: LineageNode, result: ModelLineage) -> exp.Query:
        parsed = sqlglot.parse_one(node.compiled_code or "", dialect=self.dialect)
        if not isinstance(parsed, exp.Query):
            raise TypeError(f"expected a SELECT statement, got {type(parsed).__name__}")
        return self._inline_ephemerals(parsed, result)

    def _model(self, node: LineageNode) -> None:
        result = ModelLineage(node.id, "ok")
        self.index.models[node.id] = result
        parsed = self._parse(node, result)

        key = self._cache_key(node, parsed, result.warnings) if self.cache is not None else None
        if key is not None and self.cache is not None:
            entry = self.cache.get(key)
            if entry is not None:
                self._replay(node, entry)
                return

        # what this model contributes (also after a failure), recorded for the cache
        self._registered: dict[str, str | None] | None = None
        edges: list[ColumnEdge] = []
        try:
            self._trace(node, parsed, result, edges)
        except Exception as error:  # noqa: BLE001 - one bad model must not break loading
            log.warning("column lineage failed for %s: %s", node.id, error)
            result = ModelLineage(node.id, "failed", f"{type(error).__name__}: {error}"[:500])
            self.index.models[node.id] = result
        if key is not None and self.cache is not None:
            self.cache.put(
                key,
                {
                    "status": result.status,
                    "error": result.error,
                    "warnings": result.warnings,
                    "columns": self._registered,
                    "edges": [
                        [e.source_model, e.source_column, e.target_column, e.kind, e.expression]
                        for e in edges
                    ],
                },
            )

    def _replay(self, node: LineageNode, entry: dict[str, Any]) -> None:
        """Apply a cached result: same index entries and schema registration as ``_trace``."""
        self.index.models[node.id] = ModelLineage(
            node.id, entry["status"], entry["error"], list(entry["warnings"])
        )
        if entry["columns"] is not None:
            self._register_columns(node, entry["columns"])
        for source_model, source_column, target_column, kind, expression in entry["edges"]:
            self.index.add(ColumnEdge(source_model, source_column, node.id, target_column, kind, expression))

    def _cache_key(self, node: LineageNode, parsed: exp.Query, warnings: list[str]) -> str:
        """Hash of every input ``_trace`` reads: the model's SQL and identity, and for each
        relation it references the node it resolves to and that node's columns."""
        relations: dict[str, Any] = {}
        for table in parsed.find_all(exp.Table):
            db, sch, tbl = _norm(table.catalog), _norm(table.db), _norm(table.name)
            ref = f"{db}.{sch}.{tbl}"
            if ref in relations:
                continue
            resolved = self._resolve(table)
            # every schema table sqlglot may match the (possibly partial) reference to
            candidates = sorted(
                k
                for k in self.tables_by_name.get(tbl, ())
                if (not sch or _norm(k[1]) == sch) and (not db or _norm(k[0]) == db)
            )
            relations[ref] = [
                resolved,
                self.columns.get(resolved) if resolved else None,
                [[*k, self.schema[k[0]][k[1]][k[2]]] for k in candidates],
            ]
        own = self.schema.get(node.database or "", {}).get(node.schema_name or "", {}).get(table_name(node))
        payload = [
            _cache_version(),
            self.dialect,
            node.id,
            node.database,
            node.schema_name,
            table_name(node),
            node.compiled_code,
            own,
            self.columns.get(node.id),
            warnings,
            sorted(relations.items()),
        ]
        text = json.dumps(payload, separators=(",", ":"), default=str)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _trace(
        self, node: LineageNode, parsed: exp.Query, result: ModelLineage, edges: list[ColumnEdge]
    ) -> None:
        """Qualify and trace ``parsed`` into the index; the edges are also appended to
        ``edges`` and a schema registration for ``node`` is noted in ``self._registered``."""
        try:
            # qualify works in place: the rare fallback re-parses instead of copying up front
            qualified = qualify(parsed, schema=self.mapping, dialect=self.dialect)
        except SqlglotError as error:
            result.status = "partial"
            result.warnings.append(f"could not resolve every column ({error}); lineage may be incomplete")
            reparsed = self._parse(node, ModelLineage(node.id, "ok"))
            qualified = qualify(
                reparsed, schema=self.mapping, dialect=self.dialect, validate_qualify_columns=False
            )

        # models without catalog columns still feed their downstreams; columns documented in
        # yml only (e.g. an ephemeral model with a few described columns) are completed from
        # the select list, else downstream models cannot resolve the undocumented ones
        known = self.columns.get(node.id, {})
        if any(name.lower() not in known for name in qualified.named_selects):
            documented = (
                self.schema.get(node.database or "", {}).get(node.schema_name or "", {}).get(table_name(node), {})
            )
            registered = {**{name: None for name in qualified.named_selects}, **documented}
            self._register_columns(node, registered)
            self._registered = registered

        scope = build_scope(qualified)
        roots = lineage(
            None,
            qualified,
            schema=self.mapping,
            dialect=self.dialect,
            scope=scope,
            trim_selects=False,  # only leaf sources are read; trimming copies every SELECT
            copy=False,
        )
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
                edges.append(edge)

        if unknown:
            result.status = "partial"
            result.warnings.append("relations not found in the manifest: " + ", ".join(sorted(unknown)))

    def _pipeline_import(self, source: LineageNode) -> None:
        """A source stitched to another pipeline's model (loader._stitch_pipelines) is that
        very table: link every column it shares with the upstream model 1:1."""
        source_columns = self.columns.get(source.id, {})
        for upstream_id in source.depends_on:
            for lowered, column in self.columns.get(upstream_id, {}).items():
                if lowered in source_columns:
                    self.index.add(
                        ColumnEdge(upstream_id, column, source.id, source_columns[lowered], "passthrough")
                    )

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
                    table_name(target),
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


def build_column_lineage(
    graph: LineageGraph, dialect: str | None = None, cache: ColumnLineageCache | None = None
) -> ColumnLineageIndex:
    """Parse every model of ``graph`` and return the column-level lineage index.

    With ``cache``, models whose inputs are unchanged reuse their earlier result."""
    return _Builder(graph, dialect or dialect_for(graph.adapter_type), cache).build()
