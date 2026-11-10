"""Stand-in for the dbt CLI in tests: `python fake_dbt.py docs generate --project-dir P ...`.

Writes manifest.json + catalog.json to `--target-path` (default `<project-dir>/target`),
copied from FAKE_DBT_SOURCE (a folder with a real pair), with `metadata.vars` = the parsed
`--vars` and `metadata.generated_at` = now. Knobs (environment):

    FAKE_DBT_FAIL=1         print an error and exit 1
    FAKE_DBT_GATE=<path>    after the first log line, wait until that file exists
    FAKE_DBT_DROP=<id>      leave this node out of the manifest
    FAKE_DBT_FAIL_RUN=1     a `run` (prepare) step fails
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="*")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--target-path")
    parser.add_argument("--profiles-dir")
    parser.add_argument("--target")
    parser.add_argument("--vars")
    args, extra = parser.parse_known_args()

    if args.command[:1] == ["run"]:  # a prepare step
        print(f"Running with dbt=fake step=run {' '.join(extra)} vars={args.vars}", flush=True)
        if os.getenv("FAKE_DBT_FAIL_RUN"):
            print("Runtime Error: relation raw.x does not exist", flush=True)
            return 2
        return 0

    print(f"Running with dbt=fake vars={args.vars} target={args.target}", flush=True)
    gate = os.getenv("FAKE_DBT_GATE")
    if gate:
        deadline = time.monotonic() + 30
        while not Path(gate).exists() and time.monotonic() < deadline:
            time.sleep(0.02)
    if os.getenv("FAKE_DBT_FAIL"):
        print("Database Error: could not connect to BigQuery", flush=True)
        return 1

    source = Path(os.environ["FAKE_DBT_SOURCE"])
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    drop = os.getenv("FAKE_DBT_DROP")
    if drop:
        manifest["nodes"].pop(drop, None)
    manifest["metadata"]["generated_at"] = datetime.now(UTC).isoformat()
    manifest["metadata"]["vars"] = json.loads(args.vars) if args.vars else None
    manifest["metadata"]["target"] = args.target

    target = Path(args.target_path) if args.target_path else Path(args.project_dir) / "target"
    target.mkdir(parents=True, exist_ok=True)
    (target / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (target / "catalog.json").write_bytes((source / "catalog.json").read_bytes())
    print("Catalog written", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
