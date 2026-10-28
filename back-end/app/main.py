"""FastAPI application — contract v0 (see ../contract.md)."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings
from .schemas import (
    GraphResponse,
    HealthResponse,
    MetaResponse,
    ModelDetail,
    SearchResponse,
)
from .service import GraphService

API_DESCRIPTION = """
Interactive dbt Lineage Explorer — backend.

Reads dbt artifacts (`manifest.json` + `catalog.json`) and serves a slim lineage graph,
per-model details (compiled SQL, dependencies, schema) and fuzzy search.
"""


@lru_cache(maxsize=1)
def get_service() -> GraphService:
    return GraphService(Settings.from_env())


ServiceDep = Annotated[GraphService, Depends(get_service)]

app = FastAPI(
    title="dbt Lineage Explorer API",
    description=API_DESCRIPTION,
    version="0.1.0",
    docs_url="/docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=Settings.from_env().cors_origins,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health", response_model=HealthResponse, tags=["meta"])
def health(service: ServiceDep) -> HealthResponse:
    return service.health()


@app.get("/api/meta", response_model=MetaResponse, tags=["meta"])
def meta(service: ServiceDep) -> MetaResponse:
    """Pipelines, stages, materializations and tags — used for the toolbar filters."""
    return service.meta()


@app.post("/api/reload", response_model=HealthResponse, tags=["meta"])
def reload_artifacts(service: ServiceDep) -> HealthResponse:
    """Re-read the configured artifacts from disk (after a fresh `dbt docs generate`)."""
    service.reload()
    return service.health()


@app.get("/api/graph", response_model=GraphResponse, tags=["graph"])
def graph(
    service: ServiceDep,
    pipeline: Annotated[list[str] | None, Query(description="repeatable pipeline filter")] = None,
    stage: Annotated[list[str] | None, Query(description="repeatable stage filter")] = None,
    include_sources: Annotated[bool, Query(description="include dbt sources as nodes")] = True,
) -> GraphResponse:
    return service.graph_response(
        pipelines=pipeline,
        stages=stage,
        include_sources=include_sources,
    )


@app.get("/api/search", response_model=SearchResponse, tags=["search"])
def search(
    service: ServiceDep,
    q: Annotated[str, Query(description="fuzzy query over model names, tags, descriptions")] = "",
    limit: Annotated[int, Query(ge=1, le=200)] = 20,
) -> SearchResponse:
    return service.search_models(q, limit=limit)


@app.get("/api/search/columns", response_model=SearchResponse, tags=["search"])
def search_columns(
    service: ServiceDep,
    q: Annotated[str, Query(description="fuzzy query over column names")] = "",
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
) -> SearchResponse:
    return service.search_columns(q, limit=limit)


@app.get("/api/model/{model_id:path}", response_model=ModelDetail, tags=["graph"])
def model_detail(service: ServiceDep, model_id: str) -> ModelDetail:
    """Detail for the overlay. Accepts the dbt `unique_id` or a plain model name."""
    detail = service.model_detail(model_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"model '{model_id}' not found")
    return detail
