"""Backend-driven `dbt docs generate`: the runner, the service flow, the HTTP endpoints.

dbt itself is replaced by tests/fake_dbt.py (see its docstring for the knobs)."""

from __future__ import annotations

import dataclasses
import json
import sys
import time
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import REPO_ROOT, PipelinesConfigError, Settings, load_pipelines_config
from app.dbt_runner import DbtRunner, GenerationJob, GenerationUnsupportedError, JobRunningError
from app.main import app, get_service
from app.service import GraphService

FAKE_DBT = [sys.executable, str(Path(__file__).with_name("fake_dbt.py"))]
FIXTURES = REPO_ROOT / "fixtures"
LEAF = "model.dbt_pnc.out_mfp_customer_360"
LEAF_ID = "model.bestand_mfp.out_mfp_customer_360"


@pytest.fixture(autouse=True)
def fake_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_DBT_SOURCE", str(FIXTURES / "bestand_mfp"))


def wait_for(condition: Callable[[], object], timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        time.sleep(0.02)


def wait_job(job: GenerationJob) -> GenerationJob:
    wait_for(lambda: not job.active)
    return job


def config(tmp_path: Path, body: str) -> list:
    path = tmp_path / "pipelines.yaml"
    path.write_text("pipelines:\n" + body, encoding="utf-8")
    (tmp_path / "proj").mkdir(exist_ok=True)
    return load_pipelines_config(path)


MODED = """
  - name: bestand_mfp
    project_dir: proj
    dir: artifacts
    target: prod
    execution_modes:
      full: {vars: {full_mode: true, monthly_mode: false}}
      incremental: {vars: {full_mode: false, monthly_mode: true}}
"""


# ------------------------------------------------------------------ runner
def test_runner_generates_a_mode_and_copies_it(tmp_path: Path) -> None:
    (pair,) = config(tmp_path, MODED)
    runner = DbtRunner(command=FAKE_DBT)
    done: list[GenerationJob] = []
    job = wait_job(runner.start(pair, pair.mode("incremental"), "user", done.append))

    assert job.status == "done", job.log_tail()
    assert done == [job]
    manifest = json.loads((tmp_path / "artifacts/incremental/manifest.json").read_text(encoding="utf-8"))
    assert manifest["metadata"]["vars"] == {"full_mode": False, "monthly_mode": True}
    assert manifest["metadata"]["target"] == "prod"
    assert (tmp_path / "artifacts/incremental/catalog.json").is_file()
    assert "--target-path" in job.command
    assert any("Catalog written" in line for line in job.log)
    assert not list((tmp_path / "artifacts/incremental").glob("*.tmp"))


def test_runner_without_modes_writes_dbt_target_in_place(tmp_path: Path) -> None:
    (pair,) = config(tmp_path, "  - {name: plain, project_dir: proj}\n")
    job = wait_job(DbtRunner(command=FAKE_DBT).start(pair, None, "user"))
    assert job.status == "done", job.log_tail()
    assert "--target-path" not in job.command and "--vars" not in job.command
    assert (tmp_path / "proj/target/manifest.json").is_file()


def test_runner_failure_keeps_the_log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_DBT_FAIL", "1")
    (pair,) = config(tmp_path, MODED)
    job = wait_job(DbtRunner(command=FAKE_DBT).start(pair, pair.mode("full"), "user"))
    assert job.status == "failed"
    assert job.error and "exited with code 1" in job.error and "could not connect" in job.error
    assert any("Database Error" in line for line in job.log_tail())
    assert not (tmp_path / "artifacts/full/manifest.json").exists()


def test_runner_accepts_catalog_only_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # dbt wrote manifest + partial catalog, then exited 1 because one catalog query was denied
    monkeypatch.setenv("FAKE_DBT_CATALOG_FAIL", "1")
    (pair,) = config(tmp_path, MODED)
    job = wait_job(DbtRunner(command=FAKE_DBT).start(pair, pair.mode("full"), "user"))
    assert job.status == "done", job.log_tail()
    assert job.error is None
    assert (tmp_path / "artifacts/full/manifest.json").is_file()
    assert (tmp_path / "artifacts/full/catalog.json").is_file()
    warnings = [line for line in job.log if line.startswith("warning: catalog incomplete")]
    assert len(warnings) == 1 and "partial catalog kept" in warnings[0]


def test_runner_catalog_failure_without_manifest_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_DBT_CATALOG_FAIL", "1")
    monkeypatch.setenv("FAKE_DBT_FAIL", "1")  # catalog message, but no artifacts written
    (pair,) = config(tmp_path, MODED)
    job = wait_job(DbtRunner(command=FAKE_DBT).start(pair, pair.mode("full"), "user"))
    assert job.status == "failed"
    assert job.error and "exited with code 1" in job.error
    assert not (tmp_path / "artifacts/full/manifest.json").exists()


def test_runner_catalog_failure_ignores_stale_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # a manifest left over from an earlier run in the working folder does not count
    (pair,) = config(tmp_path, MODED)
    stale = tmp_path / "artifacts/full/.dbt_target_full/manifest.json"
    stale.parent.mkdir(parents=True)
    stale.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("FAKE_DBT_CATALOG_FAIL", "1")
    monkeypatch.setenv("FAKE_DBT_FAIL", "1")
    job = wait_job(DbtRunner(command=FAKE_DBT).start(pair, pair.mode("full"), "user"))
    assert job.status == "failed"
    assert not (tmp_path / "artifacts/full/manifest.json").exists()


def test_runner_missing_executable(tmp_path: Path) -> None:
    (pair,) = config(tmp_path, MODED)
    job = wait_job(DbtRunner(command=[str(tmp_path / "no-dbt-here")]).start(pair, pair.mode("full"), "user"))
    assert job.status == "failed"
    assert job.error and "DBT_EXECUTABLE" in job.error


def test_runner_refuses_duplicates_and_queues_per_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    gate = tmp_path / "gate"
    monkeypatch.setenv("FAKE_DBT_GATE", str(gate))
    (pair,) = config(tmp_path, MODED)
    runner = DbtRunner(command=FAKE_DBT)
    first = runner.start(pair, pair.mode("full"), "user")
    with pytest.raises(JobRunningError):
        runner.start(pair, pair.mode("full"), "user")
    second = runner.start(pair, pair.mode("incremental"), "user")  # same project: waits

    wait_for(lambda: first.status == "running" and any("Running with" in line for line in first.log))
    assert second.status == "queued"
    assert runner.active_job("bestand_mfp", "full") is first
    gate.touch()
    assert wait_job(first).status == "done" and wait_job(second).status == "done"
    assert [j.id for j in runner.list()] == [second.id, first.id]


def test_runner_needs_project_dir_and_trims_history(tmp_path: Path) -> None:
    plain, project = config(tmp_path, "  - {name: plain, dir: x}\n  - {name: p, project_dir: proj}\n")
    runner = DbtRunner(command=FAKE_DBT, max_history=2)
    with pytest.raises(GenerationUnsupportedError):
        runner.start(plain, None, "user")
    for _ in range(3):
        wait_job(runner.start(project, None, "user"))
    assert len(runner.list()) == 2


def test_dbt_block_and_prepare_config(tmp_path: Path) -> None:
    path = tmp_path / "pipelines.yaml"
    path.write_text(
        """
dbt:
  command: uv run --frozen --project {here} dbt
  prepare: [run --empty --full-refresh]
pipelines:
  - {name: a, project_dir: proj}
  - {name: b, project_dir: proj, prepare: []}
  - {name: c, project_dir: proj, prepare: build --empty}
""",
        encoding="utf-8",
    )
    a, b, c = load_pipelines_config(path)
    assert a.dbt_command == ("uv", "run", "--frozen", "--project", str(tmp_path.resolve()), "dbt")
    assert a.prepare == ("run --empty --full-refresh",)
    assert b.prepare == () and c.prepare == ("build --empty",)

    bad = tmp_path / "bad.yaml"
    bad.write_text("dbt: {executable: dbt}\npipelines: [{name: a, dir: x}]\n", encoding="utf-8")
    with pytest.raises(PipelinesConfigError, match="unknown keys in 'dbt'"):
        load_pipelines_config(bad)


PREPARED = """
dbt:
  prepare: [run --empty --full-refresh]
pipelines:
  - name: bestand_mfp
    project_dir: proj
    dir: artifacts
    execution_modes:
      full: {vars: {full_mode: true}}
"""


def test_runner_runs_prepare_steps_first(tmp_path: Path) -> None:
    (pair,) = config(tmp_path, PREPARED.split("pipelines:\n", 1)[1])
    pair = dataclasses.replace(pair, prepare=("run --empty --full-refresh",))
    job = wait_job(DbtRunner(command=FAKE_DBT).start(pair, pair.mode("full"), "user"))
    assert job.status == "done", job.log_tail()
    steps = [line for line in job.log if line.startswith("$ ")]
    assert len(steps) == 2
    assert " run --empty --full-refresh " in steps[0] and '{"full_mode": true}' in steps[0]
    assert " docs generate " in steps[1]
    assert steps[0].split("--target-path ")[1] == steps[1].split("--target-path ")[1]  # same target
    assert "&&" in job.command


def test_runner_stops_when_a_prepare_step_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_DBT_FAIL_RUN", "1")
    (pair,) = config(tmp_path, PREPARED.split("pipelines:\n", 1)[1])
    pair = dataclasses.replace(pair, prepare=("run --empty",))
    job = wait_job(DbtRunner(command=FAKE_DBT).start(pair, pair.mode("full"), "user"))
    assert job.status == "failed"
    assert job.error and job.error.startswith("dbt run exited with code 2")
    assert not any("docs generate" in line for line in job.log)


def test_command_precedence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (pair,) = config(tmp_path, "  - {name: p, project_dir: proj}\n")
    pair = dataclasses.replace(pair, dbt_command=("uv", "run", "dbt"))
    monkeypatch.delenv("DBT_EXECUTABLE", raising=False)
    assert DbtRunner()._dbt(pair) == ["uv", "run", "dbt"]
    monkeypatch.setenv("DBT_EXECUTABLE", "/opt/dbt/bin/dbt")
    assert DbtRunner()._dbt(pair) == ["/opt/dbt/bin/dbt"]
    assert DbtRunner(command=["x"])._dbt(pair) == ["x"]
    assert DbtRunner()._dbt(dataclasses.replace(pair, dbt_command=None)) == ["/opt/dbt/bin/dbt"]


# ------------------------------------------------------------------ service + API
@pytest.fixture()
def gen_service(tmp_path: Path) -> GraphService:
    pairs = config(
        tmp_path,
        MODED
        + f"""
  - name: schaden_claims
    dir: {(FIXTURES / "schaden_claims").as_posix()}
""",
    )
    return GraphService(Settings(artifacts=pairs), runner=DbtRunner(command=FAKE_DBT))


@pytest.fixture()
def gen_client(gen_service: GraphService):
    app.dependency_overrides[get_service] = lambda: gen_service
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_service, None)


def test_startup_generates_missing_artifacts(gen_service: GraphService) -> None:
    assert not any(n.pipeline == "bestand_mfp" for n in gen_service.graph.nodes.values())
    (job,) = gen_service.generate_missing()
    assert (job.pipeline, job.mode, job.trigger) == ("bestand_mfp", "full", "startup")
    wait_job(job)
    wait_for(lambda: LEAF_ID in gen_service.graph.nodes)
    assert gen_service.generate_missing() == []  # on disk now


def test_switch_to_missing_mode_generates_then_switches(
    gen_service: GraphService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wait_job(gen_service.generate_missing()[0])
    gate = tmp_path / "gate"
    monkeypatch.setenv("FAKE_DBT_GATE", str(gate))
    monkeypatch.setenv("FAKE_DBT_DROP", LEAF)

    info = gen_service.set_mode("bestand_mfp", "incremental")
    assert info.active_mode == "full" and info.pending_mode == "incremental"
    assert info.modes[1].job is not None and info.modes[1].job.trigger == "mode-switch"
    assert LEAF_ID in gen_service.graph.nodes  # still the old mode

    gate.touch()
    job = gen_service.runner.latest("bestand_mfp", "incremental")
    assert job is not None
    wait_job(job)  # `done` is published only after the graph was rebuilt
    assert gen_service.active_modes["bestand_mfp"] == "incremental"
    assert LEAF_ID not in gen_service.graph.nodes
    assert gen_service.pending_modes == {}


def test_failed_switch_keeps_the_mode(gen_service: GraphService, monkeypatch: pytest.MonkeyPatch) -> None:
    wait_job(gen_service.generate_missing()[0])
    monkeypatch.setenv("FAKE_DBT_FAIL", "1")
    gen_service.set_mode("bestand_mfp", "incremental")
    job = gen_service.runner.latest("bestand_mfp", "incremental")
    assert job is not None
    wait_job(job)
    wait_for(lambda: not gen_service.pending_modes)
    assert gen_service.active_modes["bestand_mfp"] == "full"


def test_regenerate_shown_mode_rebuilds(gen_service: GraphService, monkeypatch: pytest.MonkeyPatch) -> None:
    wait_job(gen_service.generate_missing()[0])
    assert LEAF_ID in gen_service.graph.nodes
    monkeypatch.setenv("FAKE_DBT_DROP", LEAF)
    gen_service.generate("bestand_mfp")  # default: the shown mode
    wait_for(lambda: LEAF_ID not in gen_service.graph.nodes)


def test_generation_endpoints(gen_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    gate = tmp_path / "gate"
    monkeypatch.setenv("FAKE_DBT_GATE", str(gate))

    body = gen_client.post("/api/pipelines/bestand_mfp/modes/full/generate").json()
    assert body["can_generate"] is True
    assert body["modes"][0]["job"]["status"] in ("queued", "running")

    assert gen_client.post("/api/pipelines/bestand_mfp/generate", json={"mode": "full"}).status_code == 409
    assert gen_client.post("/api/pipelines/schaden_claims/generate").status_code == 400
    assert gen_client.post("/api/pipelines/bestand_mfp/modes/nope/generate").status_code == 404

    def running_with_log() -> bool:
        jobs = gen_client.get("/api/jobs").json()
        return jobs[0]["status"] == "running" and any("Running with" in line for line in jobs[0]["log_tail"])

    wait_for(running_with_log)
    (job,) = gen_client.get("/api/jobs").json()
    assert job["pipeline"] == "bestand_mfp" and job["mode"] == "full" and job["trigger"] == "user"
    assert "docs generate" in job["command"]

    gate.touch()
    wait_for(lambda: gen_client.get("/api/jobs").json()[0]["status"] == "done")
    nodes = gen_client.get("/api/graph", params={"pipeline": "bestand_mfp"}).json()["nodes"]
    assert any(n["id"] == LEAF_ID for n in nodes)

    pending = gen_client.post("/api/pipelines/bestand_mfp/mode", json={"mode": "incremental"}).json()
    assert pending["pending_mode"] == "incremental"
    claims = gen_client.get("/api/pipelines").json()[1]
    assert claims["can_generate"] is False and claims["job"] is None
