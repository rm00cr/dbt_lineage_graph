"""Execution modes: pipelines.yaml parsing, switching the shown mode, the HTTP endpoints."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import REPO_ROOT, PipelinesConfigError, Settings, load_pipelines_config
from app.main import app, get_service
from app.service import GraphService, ModeUnavailableError, UnknownPipelineError

FIXTURES = REPO_ROOT / "fixtures"
LEAF = "model.dbt_pnc.out_mfp_customer_360"  # unscoped id in the manifest
LEAF_ID = "model.bestand_mfp.out_mfp_customer_360"


def _write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


# ------------------------------------------------------------------ config
def test_modes_as_mapping_default_to_subfolders(tmp_path: Path) -> None:
    config = _write(
        tmp_path / "pipelines.yaml",
        """
pipelines:
  - name: bestand_mfp
    dir: artifacts/bestand_mfp
    execution_modes:
      full:
        vars: {full_mode: true, monthly_mode: false}
      incremental:
        vars: {full_mode: false, monthly_mode: true}
        dir: elsewhere/incr
""",
    )
    (pair,) = load_pipelines_config(config)
    assert [m.name for m in pair.modes] == ["full", "incremental"]
    assert pair.default_mode == "full"
    full, incremental = pair.modes
    assert full.vars == {"full_mode": True, "monthly_mode": False}
    assert full.manifest == tmp_path / "artifacts/bestand_mfp/full/manifest.json"
    assert full.catalog == tmp_path / "artifacts/bestand_mfp/full/catalog.json"
    assert incremental.manifest == tmp_path / "elsewhere/incr/manifest.json"
    # the pair itself points at the default mode
    assert pair.manifest == full.manifest
    assert pair.for_mode("incremental").manifest == incremental.manifest


def test_modes_as_list_and_default_mode(tmp_path: Path) -> None:
    config = _write(
        tmp_path / "pipelines.yaml",
        """
pipelines:
  - name: p
    dir: a
    default_mode: incremental_mode
    execution_modes:
      - full_mode: {vars: {full_mode: true}}
      - incremental_mode:
          manifest: x/m.json
""",
    )
    (pair,) = load_pipelines_config(config)
    assert pair.default_mode == "incremental_mode"
    assert pair.manifest == tmp_path / "x/m.json"
    assert pair.catalog is None  # explicit manifest, no dir: like at pipeline level
    assert pair.mode("incremental_mode").vars == {}


def test_project_dir_reads_target(tmp_path: Path) -> None:
    config = _write(
        tmp_path / "pipelines.yaml",
        """
pipelines:
  - name: plain
    project_dir: proj
  - name: moded
    project_dir: proj2
    execution_modes:
      full: {vars: {full_mode: true}}
  - name: explicit
    project_dir: proj3
    dir: artifacts/explicit
""",
    )
    plain, moded, explicit = load_pipelines_config(config)
    assert plain.manifest == tmp_path / "proj/target/manifest.json"
    assert plain.project_dir == tmp_path / "proj"
    assert moded.manifest == tmp_path / "proj2/target/full/manifest.json"
    assert explicit.manifest == tmp_path / "artifacts/explicit/manifest.json"


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("dir: a\n    default_mode: nope\n    execution_modes: {full: {}}", "default_mode 'nope'"),
        ("dir: a\n    execution_modes: {'bad name': {}}", "may only contain"),
        ("dir: a\n    execution_modes: {full: {vars: [1, 2]}}", "must be a mapping"),
        ("execution_modes: {full: {vars: {}}}", "has no location"),
        ("dir: a\n    execution_modes: {compiled: {}}", "reserved"),
        ("dir: a\n    execution_modes: [{full: {}}, {full: {}}]", "used twice"),
        ("catalog: c.json", "needs 'dir', 'manifest' or 'project_dir'"),
        # the old form, vars directly under the mode
        ("dir: a\n    execution_modes: [{full: {full_mode: true}}]", "belong under 'vars:'"),
    ],
)
def test_invalid_mode_config(tmp_path: Path, body: str, message: str) -> None:
    config = _write(tmp_path / "pipelines.yaml", f"pipelines:\n  - name: p\n    {body}\n")
    with pytest.raises(PipelinesConfigError, match=message):
        load_pipelines_config(config)


# ------------------------------------------------------------------ service + API
@pytest.fixture()
def moded_config(tmp_path: Path) -> Path:
    """bestand_mfp with a `full` mode (the fixture) and an `incremental` mode without the
    leaf model out_mfp_customer_360; schaden_claims without modes; `monthly` never built."""
    full = tmp_path / "bestand_mfp" / "full"
    incremental = tmp_path / "bestand_mfp" / "incremental"
    full.mkdir(parents=True)
    incremental.mkdir(parents=True)
    for name in ("manifest.json", "catalog.json"):
        shutil.copy(FIXTURES / "bestand_mfp" / name, full / name)
    manifest = json.loads((FIXTURES / "bestand_mfp" / "manifest.json").read_text(encoding="utf-8"))
    del manifest["nodes"][LEAF]
    manifest["metadata"]["generated_at"] = "2026-11-01T00:00:00Z"
    (incremental / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    shutil.copy(FIXTURES / "bestand_mfp" / "catalog.json", incremental / "catalog.json")

    return _write(
        tmp_path / "pipelines.yaml",
        f"""
pipelines:
  - name: bestand_mfp
    dir: bestand_mfp
    execution_modes:
      full: {{vars: {{full_mode: true, monthly_mode: false}}}}
      incremental: {{vars: {{full_mode: false, monthly_mode: true}}}}
      monthly: {{vars: {{monthly_mode: true}}}}
  - name: schaden_claims
    dir: {(FIXTURES / "schaden_claims").as_posix()}
""",
    )


@pytest.fixture()
def moded_service(moded_config: Path) -> GraphService:
    return GraphService(Settings(artifacts=load_pipelines_config(moded_config)))


@pytest.fixture()
def moded_client(moded_service: GraphService):
    app.dependency_overrides[get_service] = lambda: moded_service
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_service, None)


def test_service_switches_modes(moded_service: GraphService) -> None:
    full_graph = moded_service.graph
    assert LEAF_ID in full_graph.nodes

    info = moded_service.set_mode("bestand_mfp", "incremental")
    assert info.active_mode == "incremental"
    assert LEAF_ID not in moded_service.graph.nodes
    assert "incremental" in {Path(a).parent.name for a in moded_service.health().artifacts}

    moded_service.set_mode("bestand_mfp", "full")
    assert moded_service.graph is full_graph  # cached, not rebuilt

    with pytest.raises(ModeUnavailableError):
        moded_service.set_mode("bestand_mfp", "monthly")
    assert moded_service.active_modes["bestand_mfp"] == "full"
    with pytest.raises(UnknownPipelineError):
        moded_service.set_mode("bestand_mfp", "nope")
    with pytest.raises(UnknownPipelineError):
        moded_service.set_mode("nope", "full")


def test_compare_uses_active_mode(moded_service: GraphService) -> None:
    moded_service.set_mode("bestand_mfp", "incremental")
    manifest = (FIXTURES / "bestand_mfp" / "manifest.json").read_bytes()
    diff = moded_service.compare(manifest, None, label="full", pipeline="bestand_mfp")
    # the running state is `incremental`, so the full manifest adds the leaf model back
    assert [c.id for c in diff.changes if c.status == "added"] == [LEAF_ID]
    assert diff.summary.removed == 0


def test_pipelines_endpoint(moded_client: TestClient) -> None:
    body = moded_client.get("/api/pipelines").json()
    assert [p["name"] for p in body] == ["bestand_mfp", "schaden_claims"]
    bestand, claims = body
    assert bestand["active_mode"] == "full"
    assert bestand["available"] is True
    assert [(m["name"], m["available"]) for m in bestand["modes"]] == [
        ("full", True),
        ("incremental", True),
        ("monthly", False),
    ]
    assert bestand["modes"][0]["vars"] == {"full_mode": True, "monthly_mode": False}
    assert bestand["modes"][1]["generated_at"] == "2026-11-01T00:00:00Z"
    assert claims["active_mode"] is None and claims["modes"] == []


def test_set_mode_endpoint(moded_client: TestClient) -> None:
    def leaf_shown() -> bool:
        return any(n["id"] == LEAF_ID for n in moded_client.get("/api/graph").json()["nodes"])

    assert leaf_shown()
    response = moded_client.post("/api/pipelines/bestand_mfp/mode", json={"mode": "incremental"})
    assert response.status_code == 200
    assert response.json()["active_mode"] == "incremental"
    assert not leaf_shown()
    assert moded_client.get(f"/api/model/{LEAF_ID}").status_code == 404

    assert moded_client.post("/api/pipelines/bestand_mfp/mode", json={"mode": "full"}).status_code == 200
    assert leaf_shown()

    unavailable = moded_client.post("/api/pipelines/bestand_mfp/mode", json={"mode": "monthly"})
    assert unavailable.status_code == 409
    assert "no artifacts yet" in unavailable.json()["detail"]
    assert moded_client.post("/api/pipelines/bestand_mfp/mode", json={"mode": "x"}).status_code == 404
    assert moded_client.post("/api/pipelines/nope/mode", json={"mode": "full"}).status_code == 404
