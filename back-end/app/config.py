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
      - name: bestand_mfp                 # optional, default: manifest metadata.project_name
        dir: bestand_mfp                  # expects manifest.json (+ catalog.json) inside
      - name: schaden_claims
        manifest: /ci/claims/target/manifest.json
        catalog: /ci/claims/target/catalog.json    # optional

Relative paths resolve against the YAML file's folder. Pipeline names must be unique.

Environment variables
---------------------
    PIPELINES_CONFIG    path to the pipelines YAML      (default: ../fixtures/pipelines.yaml)
    BQ_CONSOLE_PROJECT  override the GCP project used for BigQuery deeplinks (3.1)
    CORS_ORIGINS        ','-separated allowed origins (default: Vite dev server)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
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


@dataclass(frozen=True)
class ArtifactPair:
    """One pipeline (= one dbt project): its manifest and (optionally) its catalog."""

    manifest: Path
    catalog: Path | None = None
    # pipeline name; None -> the manifest's `metadata.project_name`
    name: str | None = None

    @property
    def exists(self) -> bool:
        return self.manifest.is_file()


class PipelinesConfigError(ValueError):
    """The pipelines YAML is missing or malformed."""


def load_pipelines_config(path: Path) -> list[ArtifactPair]:
    """Read the pipelines YAML (format in the module docstring) into artifact pairs."""
    if not path.is_file():
        raise PipelinesConfigError(f"pipelines config not found: {path}")
    data: Any = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    entries = data.get("pipelines") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise PipelinesConfigError(f"{path}: expected a top-level 'pipelines:' list")

    base = path.parent
    pairs: list[ArtifactPair] = []
    names: set[str] = set()
    for position, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise PipelinesConfigError(f"{path}: pipeline #{position} must be a mapping")
        folder = _resolve(base, entry.get("dir"))
        manifest = _resolve(base, entry.get("manifest")) or (folder / "manifest.json" if folder else None)
        if manifest is None:
            raise PipelinesConfigError(f"{path}: pipeline #{position} needs 'dir' or 'manifest'")
        catalog = _resolve(base, entry.get("catalog")) or (folder / "catalog.json" if folder else None)
        name = str(entry["name"]).strip() if entry.get("name") else None
        if name and name in names:
            raise PipelinesConfigError(f"{path}: pipeline name {name!r} is used twice")
        if name:
            names.add(name)
        pairs.append(ArtifactPair(manifest=manifest, catalog=catalog, name=name))
    return pairs


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
