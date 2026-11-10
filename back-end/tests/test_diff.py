"""State comparison: diff engine (app/diff.py) and the POST /api/diff contract.

The head state is fixtures/dev_state/: a dev version of the bestand_mfp pipeline built by
fixtures/generate_dev_state.py (its docstring lists the intended changes). It also
re-targets every model to a dev database / schema with dev compiled SQL: none of that may
show up as a change. An upload replaces one pipeline, the others stay as they are. All
pipelines share the dbt project name `dbt_pnc`, so an upload names the pipeline it replaces.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import DEFAULT_PIPELINES_CONFIG, Settings
from app.diff import diff_graphs
from app.loader import LineageGraph, LoadedArtifacts, build_graph, read_artifacts

DEV = DEFAULT_PIPELINES_CONFIG.parent / "dev_state"
P = "model.bestand_mfp."
ADDED = P + "out_mfp_churn_risk"
REMOVED = P + "out_mfp_customer_360"
CONTRACTS = P + "int_mfp_contracts"
COVERAGES = P + "int_mfp_coverages"
OUT_CONTRACTS = P + "out_mfp_contracts"
TARIFFS = "source.bestand_mfp.raw_mfp.tariffs"
CHANGED = {ADDED, REMOVED, CONTRACTS, COVERAGES, OUT_CONTRACTS, TARIFFS}


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _swap(settings: Settings, manifest: dict, catalog: dict | None) -> LineageGraph:
    """The running pipelines with bestand_mfp swapped for the given artifacts."""
    items = read_artifacts(settings.artifacts)
    for item in items:
        if item.name == "bestand_mfp":
            item.manifest, item.catalog = manifest, catalog
    return build_graph(items)


@pytest.fixture(scope="module")
def dev_files() -> tuple[bytes, bytes]:
    return (DEV / "manifest.json").read_bytes(), (DEV / "catalog.json").read_bytes()


@pytest.fixture(scope="module")
def head(settings: Settings) -> LineageGraph:
    return _swap(settings, _read(DEV / "manifest.json"), _read(DEV / "catalog.json"))


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
        TARIFFS: "modified",
    }
    # dev database / schema / compiled SQL is target noise; the other pipeline is untouched
    assert diff.count("unchanged") == len(graph.nodes) - 5
    assert diff.columns_compared and diff.warnings == []


def test_pipeline_names_and_links_are_kept(graph: LineageGraph, head: LineageGraph) -> None:
    for node_id, node in graph.nodes.items():
        if node_id in head.nodes:
            assert head.nodes[node_id].pipeline == node.pipeline, node_id
    # schaden_claims still reads bestand_mfp's outputs: the cross-pipeline edges survive
    cross = {e for e in graph.edges if graph.nodes[e[0]].pipeline != graph.nodes[e[1]].pipeline}
    assert cross and cross <= set(head.edges)


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

    assert [(f.field, f.head) for f in nodes[TARIFFS].fields] == [("schema", "raw_mfp_v2")]


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


def test_columns_can_be_switched_off(graph: LineageGraph, settings: Settings) -> None:
    head = _swap(settings, _read(DEV / "manifest.json"), None)
    diff = diff_graphs(graph, head, compare_columns=False)
    assert not diff.columns_compared
    # otherwise every catalog column of bestand_mfp would look removed
    assert diff.nodes[OUT_CONTRACTS].status == "unchanged"
    assert all(not d.columns for d in diff.nodes.values())


def test_loaded_artifacts_project_name() -> None:
    assert LoadedArtifacts(manifest={"metadata": {"project_name": "x"}}).project_name == "x"
    assert LoadedArtifacts(manifest={}).project_name == "dbt"


# ------------------------------------------------------------------------- HTTP


def _upload(
    client: TestClient,
    manifest: bytes,
    catalog: bytes | None = None,
    pipeline: str | None = "bestand_mfp",
    **form: str,
):
    if pipeline is not None:
        form["pipeline"] = pipeline
    files = {"manifest": ("manifest.json", manifest, "application/json")}
    if catalog is not None:
        files["catalog"] = ("catalog.json", catalog, "application/json")
    return client.post("/api/diff", files=files, data=form)


def test_diff_endpoint(client: TestClient, graph: LineageGraph, dev_files: tuple[bytes, bytes]) -> None:
    response = _upload(client, *dev_files, label="feature/churn-risk")
    assert response.status_code == 200
    body = response.json()

    assert body["pipeline"] == "bestand_mfp"
    assert body["summary"] == {
        "added": 1,
        "removed": 1,
        "modified": 4,
        "unchanged": len(graph.nodes) - 5,
        "edges_added": 1,
        "edges_removed": 2,
    }
    assert body["head"]["label"] == "feature/churn-risk"
    assert body["base"]["label"] == "running state"
    assert body["columns_compared"] is True
    assert body["warnings"] == []

    # the graph is a normal GraphResponse over the union of both states
    graph_body = body["graph"]
    assert graph_body["stats"]["node_count"] == len(graph_body["nodes"]) == len(graph.nodes) + 1
    by_id = {n["id"]: n for n in graph_body["nodes"]}
    assert by_id[ADDED]["change"] == "added"
    assert by_id[ADDED]["pipeline"] == "bestand_mfp"
    assert by_id[REMOVED]["change"] == "removed"
    assert by_id[P + "src_mfp_contracts"]["change"] == "unchanged"
    assert by_id["model.schaden_claims.int_claims_cases"]["change"] == "unchanged"
    assert by_id[COVERAGES]["materialization"] == "table"  # head shape wins
    edge = next(e for e in graph_body["edges"] if e["target"] == REMOVED)
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
    assert body["warnings"] == ["No catalog.json for the upload: column changes are not compared."]
    assert body["summary"]["modified"] == 3  # out_mfp_contracts only changed a column type


def _other_project(manifest: dict, project: str) -> dict:
    """The dev manifest as a different dbt project, with its own ids and table names:
    pipelines are linked by output table name, which must be unique across pipelines (a
    copy of bestand_mfp's tables would re-wire schaden_claims)."""
    old = manifest["metadata"]["project_name"]
    renamed = copy.deepcopy(manifest)
    renamed["metadata"]["project_name"] = project
    renamed["nodes"] = {
        k.replace(f".{old}.", f".{project}."): {
            **v,
            "unique_id": k.replace(f".{old}.", f".{project}."),
            "name": "fc_" + v["name"],
            "alias": "fc_" + (v.get("alias") or v["name"]),
        }
        for k, v in manifest["nodes"].items()
    }
    renamed["sources"] = {}
    return renamed


def _assert_all_added(body: dict, graph: LineageGraph, manifest: dict) -> None:
    assert body["summary"]["removed"] == 0 and body["summary"]["modified"] == 0
    assert body["summary"]["unchanged"] == len(graph.nodes)
    assert body["summary"]["added"] == sum(1 for n in manifest["nodes"].values() if n["resource_type"] == "model")


def test_unknown_project_is_a_new_pipeline(
    client: TestClient, graph: LineageGraph, dev_files: tuple[bytes, bytes]
) -> None:
    renamed = _other_project(json.loads(dev_files[0]), "finance_controlling")
    body = _upload(client, json.dumps(renamed).encode(), pipeline=None).json()

    assert body["pipeline"] == "finance_controlling"
    assert "not one of the running pipelines (bestand_mfp, schaden_claims)" in body["warnings"][0]
    _assert_all_added(body, graph, renamed)


def test_unknown_pipeline_name_is_a_new_pipeline(
    client: TestClient, graph: LineageGraph, dev_files: tuple[bytes, bytes]
) -> None:
    renamed = _other_project(json.loads(dev_files[0]), "dbt_pnc_fc")
    body = _upload(client, json.dumps(renamed).encode(), pipeline="finance").json()

    assert body["pipeline"] == "finance"
    assert "pipeline 'finance' is not running (bestand_mfp, schaden_claims)" in body["warnings"][0]
    _assert_all_added(body, graph, renamed)


def test_ambiguous_project_name_needs_a_pipeline(client: TestClient, dev_files: tuple[bytes, bytes]) -> None:
    # every running pipeline is the dbt project dbt_pnc: the upload has to say which one
    response = _upload(client, dev_files[0], pipeline=None)
    assert response.status_code == 422
    assert "matches several running pipelines (bestand_mfp, schaden_claims)" in response.json()["detail"]


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
