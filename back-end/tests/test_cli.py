"""`back-end/.env` handling of the `lineage-api` entry point."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.cli import load_env_file


def test_env_file_fills_unset_variables_and_resolves_config_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PIPELINES_CONFIG", raising=False)
    monkeypatch.delenv("BQ_CONSOLE_PROJECT", raising=False)
    env = tmp_path / ".env"
    env.write_text("PIPELINES_CONFIG=../axa/pipelines.yaml\nBQ_CONSOLE_PROJECT=pnc-exp\n")

    load_env_file(env)

    # relative to the .env file's folder, not the current directory
    assert os.environ["PIPELINES_CONFIG"] == str((tmp_path.parent / "axa" / "pipelines.yaml").resolve())
    assert os.environ["BQ_CONSOLE_PROJECT"] == "pnc-exp"


def test_real_environment_wins_over_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PIPELINES_CONFIG", "/from/shell.yaml")
    env = tmp_path / ".env"
    env.write_text("PIPELINES_CONFIG=other.yaml\n")

    load_env_file(env)

    assert os.environ["PIPELINES_CONFIG"] == "/from/shell.yaml"


def test_missing_env_file_is_fine(tmp_path: Path) -> None:
    load_env_file(tmp_path / "nope.env")
