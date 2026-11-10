from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import DEFAULT_PIPELINES_CONFIG, Settings, load_pipelines_config
from app.loader import LineageGraph, load_graph
from app.main import app, get_service
from app.service import GraphService


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(
        artifacts=load_pipelines_config(DEFAULT_PIPELINES_CONFIG),
        bq_console_project=None,
        cors_origins=["http://localhost:5173"],
    )


@pytest.fixture(scope="session")
def graph(settings: Settings) -> LineageGraph:
    return load_graph(settings.artifacts)


@pytest.fixture(scope="session")
def service(settings: Settings) -> GraphService:
    return GraphService(settings)


@pytest.fixture(scope="session")
def client(service: GraphService) -> TestClient:
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
