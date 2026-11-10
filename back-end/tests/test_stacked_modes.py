"""Stacked execution modes: several modes of one pipeline shown at once, one in front.

Scenario, built from the bestand_mfp fixture:

    full         the fixture as is
    incremental  without out_mfp_customer_360 and out_mfp_contracts (which schaden_claims
                 reads), int_mfp_contracts compiled to other SQL, plus an extra model
                 int_mfp_contract_changes
"""

from __future__ import annotations

import copy
import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import REPO_ROOT, Settings, load_pipelines_config
from app.main import app, get_service
from app.service import GraphService, ModeUnavailableError, UnknownPipelineError

FIXTURES = REPO_ROOT / "fixtures"
RAW = "model.dbt_pnc."  # ids in the manifest; the loader scopes them per pipeline
B = "model.bestand_mfp."
LEAF = B + "out_mfp_customer_360"
OUT_CONTRACTS = B + "out_mfp_contracts"
CONTRACTS = B + "int_mfp_contracts"
CHANGES = B + "int_mfp_contract_changes"
CLAIMS_SOURCE = "source.schaden_claims.bestand_mfp.out_mfp_contracts"


@pytest.fixture()
def service(tmp_path: Path) -> GraphService:
    full = tmp_path / "bestand_mfp" / "full"
    incremental = tmp_path / "bestand_mfp" / "incremental"
    full.mkdir(parents=True)
    incremental.mkdir(parents=True)
    for name in ("manifest.json", "catalog.json"):
        shutil.copy(FIXTURES / "bestand_mfp" / name, full / name)
        shutil.copy(FIXTURES / "bestand_mfp" / name, incremental / name)

    manifest = json.loads((FIXTURES / "bestand_mfp" / "manifest.json").read_text(encoding="utf-8"))
    nodes = manifest["nodes"]
    del nodes[RAW + "out_mfp_customer_360"]
    del nodes[RAW + "out_mfp_contracts"]
    contracts = nodes[RAW + "int_mfp_contracts"]
    contracts["compiled_code"] = contracts["compiled_code"] + "\nwhere _changed_at >= current_date - 1"
    extra = copy.deepcopy(contracts)
    extra.update(
        unique_id=RAW + "int_mfp_contract_changes",
        name="int_mfp_contract_changes",
        alias="int_mfp_contract_changes",
        original_file_path="models/02_intermediate/int_mfp_contract_changes.sql",
        depends_on={"nodes": [RAW + "int_mfp_contracts"], "macros": []},
    )
    nodes[extra["unique_id"]] = extra
    (incremental / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    config = tmp_path / "pipelines.yaml"
    config.write_text(
        f"""
pipelines:
  - name: bestand_mfp
    dir: bestand_mfp
    execution_modes:
      full: {{vars: {{full_mode: true}}}}
      incremental: {{vars: {{full_mode: false}}}}
      monthly: {{vars: {{monthly_mode: true}}}}
  - name: schaden_claims
    dir: {(FIXTURES / "schaden_claims").as_posix()}
""",
        encoding="utf-8",
    )
    return GraphService(Settings(artifacts=load_pipelines_config(config)))


@pytest.fixture()
def client(service: GraphService):
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_service, None)


def _by_id(service: GraphService) -> tuple[dict, dict]:
    response = service.graph_response()
    return {n.id: n for n in response.nodes}, {(e.source, e.target): e for e in response.edges}


# ------------------------------------------------------------------ service


def test_single_mode_has_no_stack(service: GraphService) -> None:
    nodes, edges = _by_id(service)
    assert service.stack is None
    assert all(n.modes is None and n.front and not n.sql_differs for n in nodes.values())
    assert all(e.front for e in edges.values())


def test_stack_with_full_in_front(service: GraphService) -> None:
    info = service.set_modes("bestand_mfp", ["full", "incremental"], front="full")
    assert info.active_mode == "full" and info.stacked_modes == ["incremental"]
    nodes, edges = _by_id(service)

    # shared, front-only, back-only (ghost)
    assert nodes[B + "src_mfp_contracts"].modes == ["full", "incremental"]
    assert nodes[LEAF].modes == ["full"] and nodes[LEAF].front
    assert nodes[CHANGES].modes == ["incremental"] and not nodes[CHANGES].front
    # the model compiled to other SQL in the back mode
    assert nodes[CONTRACTS].sql_differs == ["incremental"]
    assert nodes[B + "src_mfp_contracts"].sql_differs == []
    # other pipelines are not stacked
    assert nodes["model.schaden_claims.int_claims_cases"].modes is None

    assert not edges[(CONTRACTS, CHANGES)].front  # only in incremental
    assert edges[(CONTRACTS, LEAF)].front
    # the rest of the API still reads the front mode
    assert CHANGES not in service.graph.nodes


def test_stack_with_incremental_in_front(service: GraphService) -> None:
    service.set_modes("bestand_mfp", ["full", "incremental"], front="incremental")
    nodes, edges = _by_id(service)
    assert nodes[CHANGES].front and nodes[CHANGES].modes == ["incremental"]
    assert not nodes[LEAF].front and nodes[LEAF].modes == ["full"]
    assert nodes[CONTRACTS].modes == ["incremental", "full"]  # front mode first

    # schaden_claims reads out_mfp_contracts, which only `full` builds: a back-only
    # cross-pipeline link, with the ghost model it comes from
    link = edges[(OUT_CONTRACTS, CLAIMS_SOURCE)]
    assert not link.front and link.cross_pipeline
    assert not nodes[OUT_CONTRACTS].front


def test_unstacking_and_cache(service: GraphService) -> None:
    service.set_modes("bestand_mfp", ["full", "incremental"], front="full")
    front_graph = service.graph
    info = service.set_modes("bestand_mfp", ["full"], front="full")
    assert info.stacked_modes == [] and service.stack is None
    assert service.graph is front_graph  # the front graph is untouched by stacking


def test_set_modes_validation(service: GraphService) -> None:
    with pytest.raises(ValueError, match="must be one of the selected"):
        service.set_modes("bestand_mfp", ["full"], front="incremental")
    with pytest.raises(UnknownPipelineError):
        service.set_modes("bestand_mfp", ["full", "nope"], front="full")
    with pytest.raises(ModeUnavailableError):  # `monthly` was never built, no project_dir
        service.set_modes("bestand_mfp", ["full", "monthly"], front="full")
    assert service.stack is None and service.stacked_modes == {}


def test_model_detail_per_mode(service: GraphService) -> None:
    service.set_modes("bestand_mfp", ["full", "incremental"], front="full")
    front = service.model_detail(CONTRACTS)
    back = service.model_detail(CONTRACTS, mode="incremental")
    assert front and back and front.compiled_code != back.compiled_code
    assert "_changed_at" in back.compiled_code
    # a ghost opens from its back mode, without asking for the mode
    ghost = service.model_detail(CHANGES)
    assert ghost and ghost.name == "int_mfp_contract_changes"
    assert service.model_detail(LEAF, mode="incremental") is None  # not in that mode


# ------------------------------------------------------------------ HTTP


def test_modes_endpoint(client: TestClient) -> None:
    response = client.post(
        "/api/pipelines/bestand_mfp/modes", json={"selected": ["full", "incremental"], "front": "full"}
    )
    assert response.status_code == 200
    assert response.json()["stacked_modes"] == ["incremental"]

    nodes = {n["id"]: n for n in client.get("/api/graph").json()["nodes"]}
    assert nodes[CHANGES]["front"] is False and nodes[CHANGES]["modes"] == ["incremental"]
    assert nodes[CONTRACTS]["sql_differs"] == ["incremental"]
    assert client.get("/api/pipelines").json()[0]["stacked_modes"] == ["incremental"]

    detail = client.get(f"/api/model/{CONTRACTS}", params={"mode": "incremental"})
    assert detail.status_code == 200 and "_changed_at" in detail.json()["compiled_code"]

    bad = client.post("/api/pipelines/bestand_mfp/modes", json={"selected": ["full"], "front": "incremental"})
    assert bad.status_code == 422
    assert client.post("/api/pipelines/nope/modes", json={"selected": ["a"], "front": "a"}).status_code == 404
    assert (
        client.post(
            "/api/pipelines/bestand_mfp/modes", json={"selected": ["monthly"], "front": "monthly"}
        ).status_code
        == 409
    )
    assert client.get(f"/api/model/{CONTRACTS}", params={"mode": "monthly"}).status_code == 409


def test_swapping_front_keeps_the_graph_shape(service: GraphService) -> None:
    """Same nodes and edges in the same order: the canvas layout does not move."""
    service.set_modes("bestand_mfp", ["full", "incremental"], front="full")
    a = service.graph_response()
    service.set_modes("bestand_mfp", ["full", "incremental"], front="incremental")
    b = service.graph_response()
    assert [n.id for n in a.nodes] == [n.id for n in b.nodes]
    assert [e.id for e in a.edges] == [e.id for e in b.edges]
    assert {n.id for n in a.nodes if not n.front} != {n.id for n in b.nodes if not n.front}
