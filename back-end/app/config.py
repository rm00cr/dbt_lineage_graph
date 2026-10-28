"""Runtime configuration of the Lineage Explorer backend.

Everything is driven by environment variables so the same image can serve fixtures
during the hackathon and real dbt artifacts afterwards.

    DBT_MANIFEST_PATH   path to manifest.json      (default: ../fixtures/manifest.json)
    DBT_CATALOG_PATH    path to catalog.json       (default: ../fixtures/catalog.json)
    DBT_ARTIFACTS       several projects at once, ';'-separated "manifest[,catalog]" pairs
                        e.g. "/a/manifest.json,/a/catalog.json;/b/manifest.json"
                        (this is the hook for feature 2.4 "lineage across pipelines")
    BQ_CONSOLE_PROJECT  override the GCP project used for BigQuery deeplinks (3.1)
    CORS_ORIGINS        ','-separated allowed origins (default: Vite dev server)
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO_ROOT / "fixtures" / "manifest.json"
DEFAULT_CATALOG = REPO_ROOT / "fixtures" / "catalog.json"

# --- stage convention (open point #1 of the kick-off, see contract.md 1.1) -------------
STAGE_PREFIXES: dict[str, str] = {
    "src_": "src",
    "stg_": "src",
    "int_": "int",
    "out_": "out",
    "mart_": "out",
}

STAGE_FOLDERS: dict[str, str] = {
    "staging": "src",
    "source": "src",
    "sources": "src",
    "intermediate": "int",
    "marts": "out",
    "mart": "out",
    "output": "out",
    "out": "out",
}

STAGE_ORDER: list[str] = ["src", "int", "out", "other"]


@dataclass(frozen=True)
class ArtifactPair:
    """One dbt project: a manifest and (optionally) its catalog."""

    manifest: Path
    catalog: Path | None = None

    @property
    def exists(self) -> bool:
        return self.manifest.is_file()


@dataclass(frozen=True)
class Settings:
    artifacts: list[ArtifactPair] = field(default_factory=list)
    bq_console_project: str | None = None
    cors_origins: list[str] = field(default_factory=list)

    @staticmethod
    def from_env() -> Settings:
        raw_multi = os.getenv("DBT_ARTIFACTS", "").strip()
        pairs: list[ArtifactPair] = []

        if raw_multi:
            for chunk in (c.strip() for c in raw_multi.split(";")):
                if not chunk:
                    continue
                parts = [p.strip() for p in chunk.split(",")]
                manifest = Path(parts[0]).expanduser()
                catalog = Path(parts[1]).expanduser() if len(parts) > 1 and parts[1] else None
                pairs.append(ArtifactPair(manifest=manifest, catalog=catalog))
        else:
            manifest = Path(os.getenv("DBT_MANIFEST_PATH", str(DEFAULT_MANIFEST))).expanduser()
            catalog_env = os.getenv("DBT_CATALOG_PATH", str(DEFAULT_CATALOG))
            catalog = Path(catalog_env).expanduser() if catalog_env else None
            pairs.append(ArtifactPair(manifest=manifest, catalog=catalog))

        origins_env = os.getenv(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173",
        )
        return Settings(
            artifacts=pairs,
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
    """Derive the pipeline stage of a dbt node (see contract.md 1.1)."""
    if resource_type == "source":
        return "src"

    lowered = name.lower()
    for prefix, stage in STAGE_PREFIXES.items():
        if lowered.startswith(prefix):
            return stage

    for segment in (original_file_path or "").lower().replace("\\", "/").split("/"):
        if segment in STAGE_FOLDERS:
            return STAGE_FOLDERS[segment]

    for tag in tags or []:
        if tag.lower().startswith("stage:"):
            candidate = tag.split(":", 1)[1].strip().lower()
            if candidate in STAGE_ORDER:
                return candidate

    return "other"
