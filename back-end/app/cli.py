"""Entry point so the API can be started with `uv run lineage-api`."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import dotenv_values

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"  # back-end/.env


def load_env_file(path: Path = ENV_FILE) -> None:
    """Apply `back-end/.env` (template: `.env.example`). Variables already set in the
    environment win, so `PIPELINES_CONFIG=... ./dev.sh` still overrides the file. A relative
    PIPELINES_CONFIG in the file is resolved against the file's folder, not the cwd."""
    if not path.is_file():
        return
    for key, value in dotenv_values(path).items():
        if value is None or key in os.environ:
            continue
        if key == "PIPELINES_CONFIG" and not Path(value).expanduser().is_absolute():
            value = str((path.parent / value).resolve())
        os.environ[key] = value


def main() -> None:
    load_env_file()

    parser = argparse.ArgumentParser(description="Run the dbt Lineage Explorer API")
    parser.add_argument("--host", default=os.getenv("API_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("API_PORT", "8000")))
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    parser.add_argument("--config", help="pipelines YAML (overrides PIPELINES_CONFIG)")
    args = parser.parse_args()

    if args.config:
        os.environ["PIPELINES_CONFIG"] = str(Path(args.config).expanduser().resolve())

    from .config import DEFAULT_PIPELINES_CONFIG

    print(f"pipelines config: {os.getenv('PIPELINES_CONFIG') or DEFAULT_PIPELINES_CONFIG}")

    import uvicorn

    # os.environ is inherited by the --reload worker process
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
