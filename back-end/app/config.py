"""Runtime configuration of the Lineage Explorer backend.

Pipelines
---------
A *pipeline* is one dbt project, delivered as its own ``manifest.json`` + ``catalog.json``
(``dbt docs generate``). Every pipeline uses the same layer layout::

    models/01_source/        -> stage src   imports raw sources and other pipelines' outputs
    models/02_intermediate/  -> stage int   internal to the pipeline
    models/03_output/        -> stage out   the pipeline's public interface

Which pipelines exist and where their artifacts live is declared in a YAML file
(see ``fixtures/pipelines.yaml``)::

    pipelines:
      - name: bestand_mfp                 # required, unique: the pipeline's identity
        dir: bestand_mfp                  # expects manifest.json (+ catalog.json) inside
      - name: schaden_claims
        manifest: /ci/claims/target/manifest.json
        catalog: /ci/claims/target/catalog.json    # optional

Relative paths resolve against the YAML file's folder. ``project_dir`` names the dbt project;
without ``dir``/``manifest`` the artifacts are read from ``<project_dir>/target/``.

Execution modes: a pipeline whose lineage depends on dbt vars declares named var
combinations, each with its own artifacts (default folder: ``<dir>/<mode>/``, where ``dir``
falls back to ``<project_dir>/target``)::

      - name: bestand_mfp
        dir: artifacts/bestand_mfp        # parent of the mode folders
        default_mode: full                # optional, default: the first mode
        execution_modes:
          full:
            vars: {full_mode: true, monthly_mode: false}
          incremental:
            vars: {full_mode: false, monthly_mode: true}
            dir: artifacts/bestand_mfp/incremental   # optional, also manifest/catalog

Exactly one mode per pipeline is shown at a time; the backend holds which (``GraphService``).

Generation: with ``project_dir`` the backend runs ``dbt docs generate`` itself (per mode with
``--vars``) when artifacts are missing or on demand (``dbt_runner.py``). Optional
``profiles_dir`` and ``target`` are passed to dbt.

The pipeline is identified by name only, never by the dbt project_name: in practice
every project has the same one (dbt_pnc). Node ids are scoped by it
(model.dbt_pnc.x -> model.<name>.x), so the name must be unique and id-safe
(letters, digits, _, -).

Environment variables
---------------------
    PIPELINES_CONFIG    path to the pipelines YAML      (default: ../fixtures/pipelines.yaml)
    DBT_EXECUTABLE      dbt executable used to generate artifacts (default: dbt on PATH)
    BQ_CONSOLE_PROJECT  override the GCP project used for BigQuery deeplinks (3.1)
    CORS_ORIGINS        ','-separated allowed origins (default: Vite dev server)
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PIPELINES_CONFIG = REPO_ROOT / "fixtures" / "pipelines.yaml"

# --- stage convention (see contract.md 1.1) --------------------------------------------
STAGE_PREFIXES: dict[str, str] = {
    "src_": "src",
    "stg_": "src",
    "int_": "int",
    "out_": "out",
    "mart_": "out",
}

# Folder names below `models/`. A numeric ordering prefix (`01_`, `2-`) is ignored, so the
# standard layout `01_source / 02_intermediate / 03_output` matches `source / intermediate /
# output` here.
STAGE_FOLDERS: dict[str, str] = {
    "source": "src",
    "sources": "src",
    "staging": "src",
    "intermediate": "int",
    "output": "out",
    "out": "out",
    "marts": "out",
    "mart": "out",
}

STAGE_ORDER: list[str] = ["src", "int", "out", "other"]

_ORDERING_PREFIX = re.compile(r"^\d+[_-]")
_PIPELINE_NAME = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True)
class ExecutionMode:
    """A named combination of dbt vars (pipelines.yaml `execution_modes`) with its own
    artifacts. Not to be confused with a node's ``meta.execution_mode`` (e.g. "daily")."""

    name: str
    vars: dict[str, Any] = field(default_factory=dict, hash=False, compare=False)
    manifest: Path = Path("manifest.json")
    catalog: Path | None = None
    dir: Path | None = None  # folder holding the artifacts (where generation writes them)


@dataclass(frozen=True)
class ArtifactPair:
    """One pipeline (= one dbt project): its name, manifest and (optionally) catalog.

    With execution modes, ``manifest``/``catalog`` are those of the default mode;
    ``for_mode`` returns the pair for another mode."""

    name: str  # the pipeline's identity (pipelines.yaml `name`)
    manifest: Path
    catalog: Path | None = None
    dir: Path | None = None
    project_dir: Path | None = None  # the dbt project (dbt_project.yml): enables generation
    profiles_dir: Path | None = None  # dbt --profiles-dir
    target: str | None = None  # dbt --target
    modes: tuple[ExecutionMode, ...] = ()
    default_mode: str | None = None
    # dbt commands run before `docs generate`, e.g. "run --empty --full-refresh"
    prepare: tuple[str, ...] = ()
    # how to call dbt, e.g. ("uv", "run", "--project", "/abs/examples", "dbt"); None -> dbt
    dbt_command: tuple[str, ...] | None = None

    @property
    def exists(self) -> bool:
        return self.manifest.is_file()

    def mode(self, name: str) -> ExecutionMode:
        for mode in self.modes:
            if mode.name == name:
                return mode
        raise KeyError(name)

    def for_mode(self, name: str) -> ArtifactPair:
        """This pipeline with the artifacts of execution mode ``name``."""
        mode = self.mode(name)
        return replace(self, manifest=mode.manifest, catalog=mode.catalog)


class PipelinesConfigError(ValueError):
    """The pipelines YAML is missing or malformed."""


# dbt writes these below target/; a mode folder there must not collide with them
_RESERVED_MODE_NAMES = {"compiled", "run", "partial_parse"}
_MODE_KEYS = {"vars", "dir", "manifest", "catalog"}


def load_pipelines_config(path: Path) -> list[ArtifactPair]:
    """Read the pipelines YAML (format in the module docstring) into artifact pairs."""
    if not path.is_file():
        raise PipelinesConfigError(f"pipelines config not found: {path}")
    data: Any = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    entries = data.get("pipelines") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise PipelinesConfigError(f"{path}: expected a top-level 'pipelines:' list")

    base = path.parent
    defaults = _parse_dbt_defaults(path, data.get("dbt"))
    pairs: list[ArtifactPair] = []
    names: set[str] = set()
    for position, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise PipelinesConfigError(f"{path}: pipeline #{position} must be a mapping")
        name = str(entry.get("name") or "").strip()
        if not name:
            raise PipelinesConfigError(f"{path}: pipeline #{position} needs a 'name'")
        if not _PIPELINE_NAME.match(name):
            raise PipelinesConfigError(
                f"{path}: pipeline name {name!r} may only contain letters, digits, '_' and '-'"
            )
        if name in names:
            raise PipelinesConfigError(f"{path}: pipeline name {name!r} is used twice")
        names.add(name)
        pairs.append(_parse_pipeline(path, base, name, entry, defaults))
    return pairs


def _parse_dbt_defaults(path: Path, raw: Any) -> dict[str, Any]:
    """Top-level `dbt:` block - how to call dbt and what to run before `docs generate`::

        dbt:
          command: uv run --frozen --project {here} dbt   # {here} = folder of this file
          prepare: [run --empty --full-refresh]          # default for every pipeline
    """
    if raw is None:
        return {"dbt_command": None, "prepare": ()}
    if not isinstance(raw, dict):
        raise PipelinesConfigError(f"{path}: 'dbt' must be a mapping with 'command' / 'prepare'")
    unknown = sorted(str(k) for k in raw if k not in ("command", "prepare"))
    if unknown:
        raise PipelinesConfigError(f"{path}: unknown keys in 'dbt': {unknown} (allowed: command, prepare)")
    command = raw.get("command")
    tokens: list[str] | None = None
    if command:
        tokens = shlex.split(command) if isinstance(command, str) else [str(t) for t in command]
        here = str(path.parent.resolve())
        tokens = [t.replace("{here}", here) for t in tokens]
    return {"dbt_command": tuple(tokens) if tokens else None, "prepare": _prepare(path, "dbt", raw.get("prepare"))}


def _prepare(path: Path, where: str, raw: Any) -> tuple[str, ...]:
    if raw is None:
        return ()
    items = [raw] if isinstance(raw, str) else raw
    if not isinstance(items, list) or not all(isinstance(i, str) and i.strip() for i in items):
        raise PipelinesConfigError(f"{path}: '{where}' prepare must be a dbt command or a list of them")
    return tuple(i.strip() for i in items)


def _parse_pipeline(
    path: Path, base: Path, name: str, entry: dict[str, Any], defaults: dict[str, Any]
) -> ArtifactPair:
    where = f"{path}: pipeline {name!r}"
    project_dir = _resolve(base, entry.get("project_dir"))
    target = str(entry.get("target") or "").strip() or None
    dbt: dict[str, Any] = {
        "project_dir": project_dir,
        "profiles_dir": _resolve(base, entry.get("profiles_dir")),
        "target": target,
        "dbt_command": defaults["dbt_command"],
        # a pipeline's own `prepare` (also an empty list) replaces the default
        "prepare": _prepare(path, name, entry["prepare"]) if "prepare" in entry else defaults["prepare"],
    }
    folder = _resolve(base, entry.get("dir"))
    # dbt's usual spot when only the project is given
    if folder is None and not entry.get("manifest") and project_dir is not None:
        folder = project_dir / "target"

    raw_modes = entry.get("execution_modes")
    if not raw_modes:
        manifest, catalog = _artifact_paths(base, entry, folder)
        if manifest is None:
            raise PipelinesConfigError(f"{where} needs 'dir', 'manifest' or 'project_dir'")
        return ArtifactPair(name=name, manifest=manifest, catalog=catalog, dir=folder, **dbt)

    modes = [_parse_mode(where, base, folder, key, spec) for key, spec in _mode_items(where, raw_modes)]
    seen: set[str] = set()
    for mode in modes:
        if mode.name in seen:
            raise PipelinesConfigError(f"{where}: execution mode {mode.name!r} is used twice")
        seen.add(mode.name)

    default = str(entry.get("default_mode") or "").strip() or modes[0].name
    if default not in seen:
        raise PipelinesConfigError(
            f"{where}: default_mode {default!r} is not one of its execution modes ({', '.join(sorted(seen))})"
        )
    active = next(m for m in modes if m.name == default)
    return ArtifactPair(
        name=name,
        manifest=active.manifest,
        catalog=active.catalog,
        dir=folder,
        modes=tuple(modes),
        **dbt,
        default_mode=default,
    )


def _mode_items(where: str, raw: Any) -> list[tuple[Any, Any]]:
    """`execution_modes` as a mapping, or as a list of single-key mappings."""
    if isinstance(raw, dict):
        return list(raw.items())
    if isinstance(raw, list):
        items: list[tuple[Any, Any]] = []
        for item in raw:
            if not isinstance(item, dict) or len(item) != 1:
                raise PipelinesConfigError(f"{where}: each execution mode must be '<name>: {{vars: ...}}'")
            items.extend(item.items())
        return items
    raise PipelinesConfigError(f"{where}: 'execution_modes' must be a mapping of mode name -> settings")


def _parse_mode(where: str, base: Path, parent: Path | None, key: Any, spec: Any) -> ExecutionMode:
    name = str(key).strip()
    if not _PIPELINE_NAME.match(name):
        raise PipelinesConfigError(
            f"{where}: execution mode {name!r} may only contain letters, digits, '_' and '-'"
        )
    if name.lower() in _RESERVED_MODE_NAMES:
        raise PipelinesConfigError(f"{where}: execution mode name {name!r} is reserved by dbt")
    spec = spec if spec is not None else {}
    if not isinstance(spec, dict):
        raise PipelinesConfigError(f"{where}: execution mode {name!r} must be a mapping with 'vars'")
    unknown = sorted(str(k) for k in spec if k not in _MODE_KEYS)
    if unknown:
        raise PipelinesConfigError(
            f"{where}: execution mode {name!r} has unknown keys {unknown} - "
            f"dbt vars belong under 'vars:' (allowed: {', '.join(sorted(_MODE_KEYS))})"
        )
    variables = spec.get("vars")
    variables = {} if variables is None else variables
    if not isinstance(variables, dict):
        raise PipelinesConfigError(f"{where}: 'vars' of execution mode {name!r} must be a mapping")

    folder = _resolve(base, spec.get("dir"))
    if folder is None and not spec.get("manifest") and parent is not None:
        folder = parent / name
    manifest, catalog = _artifact_paths(base, spec, folder)
    if manifest is None:
        raise PipelinesConfigError(
            f"{where}: execution mode {name!r} has no location - give the pipeline 'dir' or "
            "'project_dir', or the mode its own 'dir'/'manifest'"
        )
    return ExecutionMode(name=name, vars=dict(variables), manifest=manifest, catalog=catalog, dir=folder)


def _artifact_paths(
    base: Path, entry: dict[str, Any], folder: Path | None
) -> tuple[Path | None, Path | None]:
    """manifest/catalog of a pipeline or mode entry: explicit paths win over `folder`."""
    manifest = _resolve(base, entry.get("manifest")) or (folder / "manifest.json" if folder else None)
    catalog = _resolve(base, entry.get("catalog")) or (folder / "catalog.json" if folder else None)
    return manifest, catalog


def _resolve(base: Path, value: Any) -> Path | None:
    if not value:
        return None
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


@dataclass(frozen=True)
class Settings:
    artifacts: list[ArtifactPair] = field(default_factory=list)
    bq_console_project: str | None = None
    cors_origins: list[str] = field(default_factory=list)

    @staticmethod
    def from_env() -> Settings:
        config_path = Path(os.getenv("PIPELINES_CONFIG", str(DEFAULT_PIPELINES_CONFIG))).expanduser()
        origins_env = os.getenv(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173",
        )
        return Settings(
            artifacts=load_pipelines_config(config_path),
            bq_console_project=os.getenv("BQ_CONSOLE_PROJECT") or None,
            cors_origins=[o.strip() for o in origins_env.split(",") if o.strip()],
        )


def resolve_stage(
    *,
    name: str,
    resource_type: str,
    original_file_path: str | None,
    tags: list[str] | None = None,
) -> str:
    """Derive the layer (src / int / out) of a dbt node (see contract.md 1.1)."""
    if resource_type == "source":
        return "src"

    # the layer folder is the convention; name prefixes only cover models outside it
    for segment in (original_file_path or "").lower().replace("\\", "/").split("/"):
        folder = _ORDERING_PREFIX.sub("", segment)
        if folder in STAGE_FOLDERS:
            return STAGE_FOLDERS[folder]

    lowered = name.lower()
    for prefix, stage in STAGE_PREFIXES.items():
        if lowered.startswith(prefix):
            return stage

    for tag in tags or []:
        if tag.lower().startswith("stage:"):
            candidate = tag.split(":", 1)[1].strip().lower()
            if candidate in STAGE_ORDER:
                return candidate

    return "other"
