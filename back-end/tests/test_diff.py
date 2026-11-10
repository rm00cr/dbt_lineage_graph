"""State comparison: diff engine (app/diff.py) and the POST /api/diff contract.

The head state is fixtures/dev_state/ (built by fixtures/generate_dev_state.py, whose
docstring lists the intended changes). It also re-targets every model to a dev database /
schema with dev compiled SQL: none of that may show up as a change.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import DEFAULT_MANIFEST
from app.diff import diff_graphs
from app.loader import LineageGraph, load_graph_from_artifacts

DEV = DEFAULT_MANIFEST.parent / "dev_state"
P = "model.pnc_analytics."
ADDED = P + "out_mfp_churn_risk"
REMOVED = P + "out_mfp_customer_360"
CONTRACTS = P + "int_mfp_contracts"
COVERAGES = P + "int_mfp_coverages"
OUT_CONTRACTS = P + "out_mfp_contracts"
PAYMENTS = "source.pnc_analytics.raw_claims.payments"


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def dev_files() -> tuple[bytes, bytes]:
    return (DEV / "manifest.json").read_bytes(), (DEV / "catalog.json").read_bytes()


@pytest.fixture(scope="module")
def head() -> LineageGraph:
    return load_graph_from_artifacts([(_read(DEV / "manifest.json"), _read(DEV / "catalog.json"))])


# ------------------------------------------------------------------------- engine


def test_statuses(graph: LineageGraph, head: LineageGraph) -> None:
    diff = diff_graphs(graph, head)
    changed = {i: d.status for i, d in diff.nodes.items() if d.status != "unchanged"}
    assert changed == {
        ADDED: "added",
        REMOVED: "removed",
        CONTRACTS: "modified",
        COVERAGES: "modified",
        OUT_CONTRACTS: "modified",
        PAYMENTS: "modified",
    }
    # dev database / schema / compiled SQL on every model is target noise, not a change
    assert diff.count("unchanged") == len(graph.nodes) - 5
    assert diff.columns_compared and diff.warnings == []


def test_what_changed(graph: LineageGraph, head: LineageGraph) -> None:
    nodes = diff_graphs(graph, head).nodes

    contracts = nodes[CONTRACTS]
    assert contracts.code_changed and contracts.code_diff
    assert "+    c.contract_status = 'active' as is_active" in contracts.code_diff
    assert [(c.name, c.change) for c in contracts.columns] == [("is_active", "added")]

    assert [(f.field, f.base, f.head) for f in nodes[COVERAGES].fields] == [
        ("materialization", "incremental", "table")
    ]
    assert not nodes[COVERAGES].code_changed

    (column,) = nodes[OUT_CONTRACTS].columns
    assert column.change == "type_changed" and column.base_type != column.head_type

    assert [(f.field, f.head) for f in nodes[PAYMENTS].fields] == [("schema", "raw_claims_v2")]


def test_edges(graph: LineageGraph, head: LineageGraph) -> None:
    edges = diff_graphs(graph, head).edges
    assert {e for e, s in edges.items() if s == "added"} == {(CONTRACTS, ADDED)}
    assert {e for e, s in edges.items() if s == "removed"} == {
        (CONTRACTS, REMOVED),
        (P + "src_mfp_partners", REMOVED),
    }


def test_same_state_is_unchanged(graph: LineageGraph) -> None:
    diff = diff_graphs(graph, graph)
    assert {d.status for d in diff.nodes.values()} == {"unchanged"}
    assert set(diff.edges.values()) == {"unchanged"}


def test_without_catalog_columns_are_not_compared(graph: LineageGraph) -> None:
    head = load_graph_from_artifacts([(_read(DEV / "manifest.json"), None)])
    diff = diff_graphs(graph, head)
    assert not diff.columns_compared
    assert "column changes are not compared" in diff.warnings[0]
    # otherwise every catalog column would look removed
    assert diff.nodes[OUT_CONTRACTS].status == "unchanged"
    assert all(not d.columns for d in diff.nodes.values())


# ------------------------------------------------------------------------- HTTP


def _upload(client: TestClient, manifest: bytes, catalog: bytes | None = None, **form: str):
    files = {"manifest": ("manifest.json", manifest, "application/json")}
    if catalog is not None:
        files["catalog"] = ("catalog.json", catalog, "application/json")
    return client.post("/api/diff", files=files, data=form)


def test_diff_endpoint(client: TestClient, dev_files: tuple[bytes, bytes]) -> None:
    response = _upload(client, *dev_files, label="feature/churn-risk")
    assert response.status_code == 200
    body = response.json()

    assert body["summary"] == {
        "added": 1,
        "removed": 1,
        "modified": 4,
        "unchanged": 24,
        "edges_added": 1,
        "edges_removed": 2,
    }
    assert body["head"]["label"] == "feature/churn-risk"
    assert body["base"]["label"] == "running state"
    assert body["columns_compared"] is True

    # the graph is a normal GraphResponse over the union of both states
    graph = body["graph"]
    assert graph["stats"]["node_count"] == len(graph["nodes"]) == 30  # 29 running + 1 added
    by_id = {n["id"]: n for n in graph["nodes"]}
    assert by_id[ADDED]["change"] == "added"
    assert by_id[REMOVED]["change"] == "removed"
    assert by_id[P + "src_mfp_contracts"]["change"] == "unchanged"
    assert by_id[COVERAGES]["materialization"] == "table"  # head shape wins
    edge = next(e for e in graph["edges"] if e["target"] == REMOVED)
    assert edge["change"] == "removed"

    assert [c["status"] for c in body["changes"]] == ["added", *["modified"] * 4, "removed"]
    contracts = next(c for c in body["changes"] if c["id"] == CONTRACTS)
    assert contracts["code_changed"] and contracts["code_diff"].startswith("--- running/")


def test_model_detail_from_state(client: TestClient, dev_files: tuple[bytes, bytes]) -> None:
    state = _upload(client, *dev_files).json()["state_id"]

    added = client.get(f"/api/model/{ADDED}", params={"state": state})
    assert added.status_code == 200
    assert added.json()["database"] == "pnc-analytics-dev"
    assert [d["name"] for d in added.json()["dependencies"]] == ["int_mfp_contracts"]

    # a removed node is not in the state: falls back to the running graph
    removed = client.get(f"/api/model/{REMOVED}", params={"state": state})
    assert removed.status_code == 200 and removed.json()["database"] == "pnc-analytics-prd"

    # without a state the added model does not exist
    assert client.get(f"/api/model/{ADDED}").status_code == 404
    gone = client.get(f"/api/model/{ADDED}", params={"state": "nope"})
    assert gone.status_code == 404 and "upload the files again" in gone.json()["detail"]


def test_diff_without_catalog(client: TestClient, dev_files: tuple[bytes, bytes]) -> None:
    body = _upload(client, dev_files[0]).json()
    assert body["columns_compared"] is False
    assert body["head"]["catalog_loaded"] is False
    assert body["warnings"]


@pytest.mark.parametrize(
    ("manifest", "catalog", "message"),
    [
        (b"{not json", None, "not valid JSON"),
        (b"[1, 2]", None, "must be a JSON object"),
        (b'{"metadata": {}}', None, "no 'nodes'"),
        (b'{"nodes": {}}', None, "no models or sources"),
        (None, b"{}", "catalog.json has no 'nodes'"),
    ],
)
def test_diff_rejects_bad_files(
    client: TestClient,
    dev_files: tuple[bytes, bytes],
    manifest: bytes | None,
    catalog: bytes | None,
    message: str,
) -> None:
    response = _upload(client, manifest or dev_files[0], catalog)
    assert response.status_code == 422
    assert message in response.json()["detail"]


def test_old_states_are_evicted(client: TestClient, service, dev_files: tuple[bytes, bytes]) -> None:
    first = _upload(client, dev_files[0]).json()["state_id"]
    for _ in range(3):
        _upload(client, dev_files[0])
    assert first not in service.states
    assert len(service.states) == 3
