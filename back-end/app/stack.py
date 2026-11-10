"""Stacked execution modes: several modes of a pipeline shown at once, one of them in front.

The *front* graph is the normal graph of the shown (front) modes. For every additional
selected *back* mode of a pipeline there is one more graph: the same combination of modes,
only that pipeline switched to the back mode - so links between pipelines come out exactly
as they are in that mode. The stack merges them:

* every node of the front graph, plus *ghost* nodes that exist only in a back mode
* for nodes of a stacked pipeline: which selected modes contain them (front mode first)
* which back modes compile a shared model to different SQL than the front mode
* every front edge, plus edges that exist only in a back mode

Like ``loader.py`` / ``diff.py`` this is plain Python (no FastAPI / Pydantic).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from .loader import LineageGraph, LineageNode


@dataclass
class ModeStack:
    front: LineageGraph
    # pipeline -> its front mode (stacked pipelines only)
    front_modes: dict[str, str]
    nodes: dict[str, LineageNode] = field(default_factory=dict)
    # node id -> selected modes of its pipeline that contain it, front mode first
    node_modes: dict[str, list[str]] = field(default_factory=dict)
    # node id -> back modes whose SQL for this model differs from the front mode's
    sql_differs: dict[str, list[str]] = field(default_factory=dict)
    edges: list[tuple[str, str]] = field(default_factory=list)
    # edges that exist only in a back mode
    back_edges: set[tuple[str, str]] = field(default_factory=set)
    # (pipeline, back mode) -> its graph, for details of ghost nodes
    back: dict[tuple[str, str], LineageGraph] = field(default_factory=dict)

    def in_front(self, node_id: str) -> bool:
        return node_id in self.front.nodes

    def graph_with(self, node_id: str) -> LineageGraph | None:
        """The graph a node is read from: the front graph, else the first back mode having it."""
        if node_id in self.front.nodes:
            return self.front
        for graph in self.back.values():
            if node_id in graph.nodes:
                return graph
        return None


def build_stack(
    front: LineageGraph,
    front_modes: Mapping[str, str],
    back: Mapping[tuple[str, str], LineageGraph],
) -> ModeStack:
    """Merge the front graph with one graph per ``(pipeline, back mode)``."""
    stacked = {pipeline for pipeline, _ in back}
    stack = ModeStack(
        front=front,
        front_modes={p: m for p, m in front_modes.items() if p in stacked},
        nodes=dict(front.nodes),
        edges=list(front.edges),
        back=dict(back),
    )
    for node in front.nodes.values():
        if node.pipeline in stacked:
            stack.node_modes[node.id] = [front_modes[node.pipeline]]

    front_edges = set(front.edges)
    for (pipeline, mode), graph in back.items():
        for node in graph.nodes.values():
            if node.pipeline != pipeline:
                continue  # other pipelines show their front mode in this graph too
            stack.node_modes.setdefault(node.id, []).append(mode)
            shown = front.nodes.get(node.id)
            if shown is None:
                stack.nodes.setdefault(node.id, node)  # ghost: only in back modes
            elif _code(shown) != _code(node):
                stack.sql_differs.setdefault(node.id, []).append(mode)

        for edge in graph.edges:
            if edge in front_edges or edge in stack.back_edges:
                continue
            source, target = graph.nodes[edge[0]], graph.nodes[edge[1]]
            if pipeline not in (source.pipeline, target.pipeline):
                continue
            stack.back_edges.add(edge)
            stack.edges.append(edge)
            # an edge to a model of another pipeline that this mode links differently
            for end in (source, target):
                stack.nodes.setdefault(end.id, end)
    return stack


def _code(node: LineageNode) -> str:
    """What a mode changes: dbt vars change the compiled SQL (the raw SQL is the same)."""
    code = node.compiled_code or node.raw_code or ""
    return "\n".join(line.rstrip() for line in code.strip().splitlines())
