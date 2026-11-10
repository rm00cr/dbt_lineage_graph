"""Background ``dbt docs generate`` runs that (re)build a pipeline's artifacts.

One job = one pipeline, optionally one execution mode (its ``vars`` go to ``--vars``). A job
runs in a daemon thread; its output is streamed line by line into ``job.log`` so the UI can
follow it live. Runs in the same dbt project are serialised (they would share
``target/partial_parse.msgpack`` and the like); the others wait as ``queued``.

Where the artifacts go:

* a pipeline without modes whose artifacts live in ``<project_dir>/target/`` (the default
  without ``dir``/``manifest``): dbt writes them there itself, nothing is copied
* everything else: dbt writes to its own ``--target-path`` next to the destination
  (``.dbt_target_<mode>``), then ``manifest.json``/``catalog.json`` are copied to the
  configured paths - via a temp file + ``os.replace``, so the API never reads half a file

No FastAPI in here: plain threads and dataclasses, easy to test with a fake dbt command.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import shutil
import subprocess
import threading
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from .config import ArtifactPair, ExecutionMode

log = logging.getLogger(__name__)

JobStatus = Literal["queued", "running", "done", "failed"]
JobTrigger = Literal["startup", "user", "mode-switch"]

LOG_LINES = 400  # kept per job
TAIL_LINES = 60  # sent to the UI
MAX_HISTORY = 20  # finished jobs kept


class GenerationError(Exception):
    """A job cannot be started."""


class GenerationUnsupportedError(GenerationError):
    """The pipeline has no ``project_dir`` (-> HTTP 400)."""


class JobRunningError(GenerationError):
    """The same pipeline / mode is already being generated (-> HTTP 409)."""


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class GenerationJob:
    pipeline: str
    mode: str | None
    trigger: JobTrigger
    command: list[str]
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: JobStatus = "queued"
    started_at: datetime = field(default_factory=_now)
    finished_at: datetime | None = None
    error: str | None = None
    # done / failed, set before on_done runs; `status` follows once on_done is through
    outcome: JobStatus | None = None
    log: deque[str] = field(default_factory=lambda: deque(maxlen=LOG_LINES))

    @property
    def active(self) -> bool:
        return self.status in ("queued", "running")

    @property
    def key(self) -> tuple[str, str | None]:
        return (self.pipeline, self.mode)

    def log_tail(self, lines: int = TAIL_LINES) -> list[str]:
        return list(self.log)[-lines:]


@dataclass(frozen=True)
class _Plan:
    """What one job runs and where its output goes."""

    steps: list[list[str]]  # dbt invocations in order: the prepare commands, then docs generate
    cwd: Path  # the dbt project
    produced_dir: Path  # where dbt writes manifest.json / catalog.json
    manifest: Path  # destination
    catalog: Path | None  # destination; None -> catalog not kept
    copy: bool

    @property
    def command(self) -> list[str]:
        """All steps as one display command line."""
        joined: list[str] = []
        for step in self.steps:
            joined += [*(["&&"] if joined else []), *step]
        return joined


class DbtRunner:
    def __init__(self, command: list[str] | None = None, max_history: int = MAX_HISTORY) -> None:
        # how dbt is called: this > env DBT_EXECUTABLE > pipelines.yaml `dbt.command` > dbt
        self._command = command
        self.max_history = max_history
        self.jobs: OrderedDict[str, GenerationJob] = OrderedDict()  # oldest first
        self._lock = threading.Lock()
        self._project_locks: dict[Path, threading.Lock] = {}

    # ------------------------------------------------------------------ queries
    def list(self) -> list[GenerationJob]:
        """Newest first."""
        with self._lock:
            return list(reversed(self.jobs.values()))

    def latest(self, pipeline: str, mode: str | None) -> GenerationJob | None:
        with self._lock:
            for job in reversed(self.jobs.values()):
                if job.key == (pipeline, mode):
                    return job
        return None

    def active_job(self, pipeline: str, mode: str | None) -> GenerationJob | None:
        job = self.latest(pipeline, mode)
        return job if job and job.active else None

    # ------------------------------------------------------------------ start
    def start(
        self,
        pair: ArtifactPair,
        mode: ExecutionMode | None,
        trigger: JobTrigger,
        on_done: Callable[[GenerationJob], None] | None = None,
    ) -> GenerationJob:
        if pair.project_dir is None:
            raise GenerationUnsupportedError(
                f"pipeline '{pair.name}' has no 'project_dir' in pipelines.yaml: cannot run dbt"
            )
        plan = self._plan(pair, mode)
        with self._lock:
            mode_name = mode.name if mode else None
            if any(j.active and j.key == (pair.name, mode_name) for j in self.jobs.values()):
                what = f"'{pair.name}' ({mode_name})" if mode_name else f"'{pair.name}'"
                raise JobRunningError(f"{what} is already being generated")
            job = GenerationJob(pipeline=pair.name, mode=mode_name, trigger=trigger, command=plan.command)
            self.jobs[job.id] = job
            self._trim()
            project_lock = self._project_locks.setdefault(pair.project_dir.resolve(), threading.Lock())

        thread = threading.Thread(
            target=self._run, args=(job, plan, project_lock, on_done), name=f"dbt-{job.id}", daemon=True
        )
        thread.start()
        return job

    def _trim(self) -> None:
        finished = [j for j in self.jobs.values() if not j.active]
        for job in finished[: max(0, len(finished) - self.max_history)]:
            del self.jobs[job.id]

    def _dbt(self, pair: ArtifactPair) -> list[str]:
        if self._command:
            return list(self._command)
        executable = os.getenv("DBT_EXECUTABLE")
        if executable:
            return [executable]
        return list(pair.dbt_command or ("dbt",))

    def _plan(self, pair: ArtifactPair, mode: ExecutionMode | None) -> _Plan:
        assert pair.project_dir is not None
        project = pair.project_dir
        manifest = mode.manifest if mode else pair.manifest
        catalog = mode.catalog if mode else pair.catalog

        flags = ["--project-dir", str(project)]
        if pair.profiles_dir:
            flags += ["--profiles-dir", str(pair.profiles_dir)]
        if pair.target:
            flags += ["--target", pair.target]
        if mode is not None and mode.vars:
            flags += ["--vars", json.dumps(mode.vars)]

        default_target = project / "target"
        in_place = (
            mode is None
            and manifest == default_target / "manifest.json"
            and catalog in (None, default_target / "catalog.json")
        )
        produced = default_target if in_place else manifest.parent / f".dbt_target_{mode.name if mode else 'default'}"
        if not in_place:
            flags += ["--target-path", str(produced)]

        dbt = self._dbt(pair)
        steps = [[*dbt, *shlex.split(command), *flags] for command in pair.prepare]
        steps.append([*dbt, "docs", "generate", *flags])
        return _Plan(
            steps=steps, cwd=project, produced_dir=produced, manifest=manifest, catalog=catalog, copy=not in_place
        )

    # ------------------------------------------------------------------ run
    def _run(
        self,
        job: GenerationJob,
        plan: _Plan,
        project_lock: threading.Lock,
        on_done: Callable[[GenerationJob], None] | None,
    ) -> None:
        if not project_lock.acquire(blocking=False):
            job.log.append("waiting for another dbt run in the same project ...")
            project_lock.acquire()
        try:
            job.status = "running"
            job.started_at = _now()
            job.error = self._execute(job, plan)
        except Exception as error:  # never let a job thread die silently
            log.exception("dbt job %s failed", job.id)
            job.error = f"{type(error).__name__}: {error}"
        finally:
            project_lock.release()
        job.outcome = "failed" if job.error else "done"

        # the outcome is published only after on_done: whoever sees `done` (the UI polling
        # /api/jobs) also sees the graph rebuilt from the new artifacts
        if on_done is not None:
            try:
                on_done(job)
            except Exception:
                log.exception("on_done of dbt job %s failed", job.id)
        with self._lock:
            job.finished_at = _now()
            job.status = job.outcome
            self._trim()

    def _execute(self, job: GenerationJob, plan: _Plan) -> str | None:
        """Run the dbt steps and put the artifacts in place. Returns an error message, None if fine."""
        for step in plan.steps:
            error = self._step(job, plan.cwd, step)
            if error:
                return error

        produced_manifest = plan.produced_dir / "manifest.json"
        if not produced_manifest.is_file():
            return f"dbt finished but wrote no manifest.json to {plan.produced_dir}"
        if plan.copy:
            _replace(produced_manifest, plan.manifest)
            produced_catalog = plan.produced_dir / "catalog.json"
            if plan.catalog is not None and produced_catalog.is_file():
                _replace(produced_catalog, plan.catalog)
            job.log.append(f"artifacts written to {plan.manifest.parent}")
        return None

    @staticmethod
    def _step(job: GenerationJob, cwd: Path, args: list[str]) -> str | None:
        """Run one dbt invocation, streaming its output into the job log."""
        executable = shutil.which(args[0]) or args[0]
        job.log.append("$ " + " ".join(args))
        env = {**os.environ, "DBT_USE_COLORS": "false", "PYTHONIOENCODING": "utf-8"}
        try:
            process = subprocess.Popen(
                [executable, *args[1:]],
                cwd=str(cwd),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
            )
        except OSError as error:
            message = (
                f"cannot start dbt ({args[0]}): {error.strerror or error}. "
                "Is dbt installed? Set DBT_EXECUTABLE or `dbt.command` in pipelines.yaml."
            )
            job.log.append(message)
            return message

        assert process.stdout is not None
        for line in process.stdout:
            job.log.append(line.rstrip("\r\n"))
        code = process.wait()
        if code != 0:
            what = " ".join(_dbt_subcommand(args))
            return f"dbt {what} exited with code {code}" + _last_error(job.log)
        return None


def _dbt_subcommand(args: list[str]) -> list[str]:
    """`docs generate` / `run --empty` out of a full command line (for messages)."""
    for known in (["docs", "generate"], ["run"], ["build"], ["seed"], ["deps"], ["compile"]):
        for i in range(len(args) - len(known) + 1):
            if args[i : i + len(known)] == known:
                return known
    return [args[-1]]


def _replace(source: Path, destination: Path) -> None:
    """Copy atomically: readers see the old file or the new one, never half of it."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(f".{destination.name}.{uuid.uuid4().hex[:8]}.tmp")
    shutil.copyfile(source, temp)
    os.replace(temp, destination)


def _last_error(lines: deque[str]) -> str:
    for line in reversed(lines):
        if "error" in line.lower() and not line.startswith("$ "):
            return f": {line.strip()}"
    return ""
