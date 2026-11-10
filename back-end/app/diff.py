"""State comparison: what changes between the running lineage graph and another state.

The *base* is what the service already serves (the running / production artifacts), the
*head* is another state of the same project, e.g. the ``manifest.json`` + ``catalog.json``
of a development branch. Every node and edge of the union of both graphs gets a status:

    added       only in head
    removed     only in base
    modified    in both, but something that matters changed (see below)
    unchanged   in both, identical for our purposes

What counts as "modified"
-------------------------
A dev manifest is normally compiled against a *dev target*: every model lands in another
database / schema and its compiled SQL references other relations. Comparing those would
mark the whole graph as modified, so - like dbt's own ``state:modified`` selector - the
comparison looks at what the developer wrote, not at where the target puts it:

* the model's ``raw_code`` (whitespace-normalised), not ``compiled_code``
* configuration: materialization, alias, group, pipeline, stage, tags, execution mode
* documentation: the description
* upstream dependencies (the edges)
* columns (added / removed / type changed) - only when *both* sides came with a catalog,
  otherwise a missing catalog would look like every column was dropped
* for **sources** also ``database`` / ``schema``: they are not target dependent, a
  changed source location is a real change

Like ``loader.py`` this is plain Python (no FastAPI / Pydantic). It does not care where
the head graph comes from - an upload today, a GitHub branch's CI artifacts later.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field
from typing import Literal

from .loader import LineageGraph, LineageNode

ChangeStatus = Literal["added", "removed", "modified", "unchanged"]
ColumnChangeKind = Literal["added", "removed", "type_changed"]

MAX_CODE_DIFF_LINES = 400

# field name -> how to read it from a node; compared for every node in both states
_COMPARED_FIELDS: dict[str, str] = {
    "materialization": "materialization",
    "alias": "alias",
    "group": "group",
    "pipeline": "pipeline",
    "stage": "stage",
    "tags": "tags",
    "execution_mode": "execution_mode",
    "description": "description",
}
# only for sources: where the raw data lives does not depend on the dbt target
_SOURCE_FIELDS: dict[str, str] = {"database": "database", "schema": "schema_name"}


@dataclass(frozen=True)
class FieldChange:
    field: str
    base: str | None
    head: str | None


@dataclass(frozen=True)
class ColumnChange:
    name: str
    change: ColumnChangeKind
    base_type: str | None = None
    head_type: str | None = None


@dataclass
class NodeDiff:
    id: str
    status: ChangeStatus
    fields: list[FieldChange] = field(default_factory=list)
    columns: list[ColumnChange] = field(default_factory=list)
    code_changed: bool = False
    code_diff: str | None = None
    upstream_added: list[str] = field(default_factory=list)
    upstream_removed: list[str] = field(default_factory=list)


@dataclass
class GraphDiff:
    nodes: dict[str, NodeDiff]
    edges: dict[tuple[str, str], ChangeStatus]
    columns_compared: bool
    warnings: list[str] = field(default_factory=list)

    def count(self, status: ChangeStatus) -> int:
        return sum(1 for n in self.nodes.values() if n.status == status)

    def edge_count(self, status: ChangeStatus) -> int:
        return sum(1 for s in self.edges.values() if s == status)


# --------------------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------------------


def diff_graphs(base: LineageGraph, head: LineageGraph, *, compare_columns: bool | None = None) -> GraphDiff:
    """Compare two lineage graphs node by node (keyed on the dbt ``unique_id``).

    ``compare_columns``: whether column changes count. Default: only when both graphs have a
    catalog. A caller that knows better (e.g. only one pipeline's catalog is missing) passes
    it explicitly and explains it in its own warnings.
    """
    warnings: list[str] = []
    if compare_columns is None:
        compare_columns = base.catalog_loaded and head.catalog_loaded
        if not compare_columns:
            missing = "the uploaded state" if base.catalog_loaded else "the running state"
            if not base.catalog_loaded and not head.catalog_loaded:
                missing = "both states"
            warnings.append(f"No catalog.json for {missing}: column changes are not compared.")
    columns_compared = compare_columns

    nodes: dict[str, NodeDiff] = {}
    for node_id in base.nodes.keys() | head.nodes.keys():
        before, after = base.nodes.get(node_id), head.nodes.get(node_id)
        if before is None:
            nodes[node_id] = NodeDiff(id=node_id, status="added")
        elif after is None:
            nodes[node_id] = NodeDiff(id=node_id, status="removed")
        else:
            nodes[node_id] = _diff_node(before, after, columns_compared)

    base_edges, head_edges = set(base.edges), set(head.edges)
    edges: dict[tuple[str, str], ChangeStatus] = {}
    for edge in base_edges | head_edges:
        if edge not in base_edges:
            edges[edge] = "added"
        elif edge not in head_edges:
            edges[edge] = "removed"
        else:
            edges[edge] = "unchanged"

    return GraphDiff(nodes=nodes, edges=edges, columns_compared=columns_compared, warnings=warnings)


# --------------------------------------------------------------------------------------
# internals
# --------------------------------------------------------------------------------------


def _diff_node(before: LineageNode, after: LineageNode, columns_compared: bool) -> NodeDiff:
    diff = NodeDiff(id=after.id, status="unchanged")

    compared = dict(_COMPARED_FIELDS)
    if after.resource_type == "source":
        compared |= _SOURCE_FIELDS
    for name, attr in compared.items():
        old, new = _display(getattr(before, attr)), _display(getattr(after, attr))
        if old != new:
            diff.fields.append(FieldChange(field=name, base=old, head=new))

    old_code, new_code = _normalise_code(before.raw_code), _normalise_code(after.raw_code)
    if old_code != new_code:
        diff.code_changed = True
        diff.code_diff = _unified_diff(old_code, new_code, after.name)

    old_parents, new_parents = set(before.depends_on), set(after.depends_on)
    diff.upstream_added = sorted(new_parents - old_parents)
    diff.upstream_removed = sorted(old_parents - new_parents)

    if columns_compared:
        diff.columns = _diff_columns(before, after)

    if diff.fields or diff.code_changed or diff.upstream_added or diff.upstream_removed or diff.columns:
        diff.status = "modified"
    return diff


def _diff_columns(before: LineageNode, after: LineageNode) -> list[ColumnChange]:
    old = {c.name.lower(): c for c in before.columns}
    new = {c.name.lower(): c for c in after.columns}
    changes: list[ColumnChange] = []
    for key in sorted(old.keys() | new.keys()):
        a, b = old.get(key), new.get(key)
        if a is None and b is not None:
            changes.append(ColumnChange(name=b.name, change="added", head_type=b.type))
        elif b is None and a is not None:
            changes.append(ColumnChange(name=a.name, change="removed", base_type=a.type))
        elif a is not None and b is not None and a.type and b.type and a.type.lower() != b.type.lower():
            changes.append(
                ColumnChange(name=b.name, change="type_changed", base_type=a.type, head_type=b.type)
            )
    return changes


def _display(value: object) -> str | None:
    if value is None or value == "" or value == []:
        return None
    if isinstance(value, list):
        return ", ".join(sorted(str(v) for v in value))
    return str(value)


def _normalise_code(code: str | None) -> str:
    """Ignore trailing whitespace and blank-line noise, keep everything else."""
    if not code:
        return ""
    lines = [line.rstrip() for line in code.replace("\r\n", "\n").split("\n")]
    return "\n".join(lines).strip()


def _unified_diff(old: str, new: str, name: str) -> str:
    lines = list(
        difflib.unified_diff(
            old.splitlines(),
            new.splitlines(),
            fromfile=f"running/{name}.sql",
            tofile=f"uploaded/{name}.sql",
            lineterm="",
            n=3,
        )
    )
    if len(lines) > MAX_CODE_DIFF_LINES:
        hidden = len(lines) - MAX_CODE_DIFF_LINES
        lines = [*lines[:MAX_CODE_DIFF_LINES], f"... {hidden} more diff lines not shown"]
    return "\n".join(lines)
