"""FastAPI application — contract v0 (see ../contract.md)."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .column_lineage import Direction
from .config import Settings
from .schemas import (
    ColumnLineageResponse,
    DiffResponse,
    GraphResponse,
    HealthResponse,
    LineageStatusResponse,
    MetaResponse,
    ModelDetail,
    SearchResponse,
)
from .service import ArtifactError, GraphService, UnknownStateError

API_DESCRIPTION = """
Interactive dbt Lineage Explorer — backend.

Reads dbt artifacts (`manifest.json` + `catalog.json`) and serves a slim lineage graph,
per-model details (compiled SQL, dependencies, schema) and fuzzy search, and compares the
running state with another state of the project (`POST /api/diff`).
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


@app.get("/api/lineage/column", response_model=ColumnLineageResponse, tags=["lineage"])
def column_lineage(
    service: ServiceDep,
    model: Annotated[str, Query(description="dbt unique_id or plain model name")],
    column: Annotated[str, Query(description="column name (case-insensitive)")],
    direction: Annotated[Direction, Query(description="up = origins, down = impact")] = "both",
    depth: Annotated[int | None, Query(ge=1, le=50, description="max hops; omit for all")] = None,
) -> ColumnLineageResponse:
    """Column-level lineage (2.3): a column's upstream origins and/or downstream impact."""
    result = service.column_lineage_trace(model, column, direction, depth)
    if result is None:
        raise HTTPException(status_code=404, detail=f"column '{column}' of '{model}' not found")
    return result


@app.get("/api/lineage/status", response_model=LineageStatusResponse, tags=["lineage"])
def lineage_status(service: ServiceDep) -> LineageStatusResponse:
    """Which models the SQL parser understood: coverage of the column-level lineage."""
    return service.lineage_status()


@app.post("/api/diff", response_model=DiffResponse, tags=["diff"])
async def diff_state(
    service: ServiceDep,
    manifest: Annotated[UploadFile, File(description="manifest.json of the state to compare")],
    catalog: Annotated[UploadFile | None, File(description="catalog.json of that state (optional)")] = None,
    label: Annotated[str | None, Form(description="name shown for the uploaded state")] = None,
) -> DiffResponse:
    """Compare the running state with an uploaded one: every node and edge gets a `change`."""
    manifest_bytes = await manifest.read()
    catalog_bytes = await catalog.read() if catalog is not None else None
    try:
        return service.compare(
            manifest_bytes,
            catalog_bytes or None,
            label=(label or "").strip() or manifest.filename or "uploaded state",
        )
    except ArtifactError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


@app.get("/api/model/{model_id:path}", response_model=ModelDetail, tags=["graph"])
def model_detail(
    service: ServiceDep,
    model_id: str,
    state: Annotated[str | None, Query(description="state_id of a comparison: read from that state")] = None,
) -> ModelDetail:
    """Detail for the overlay. Accepts the dbt `unique_id` or a plain model name."""
    try:
        detail = service.model_detail(model_id, state=state)
    except UnknownStateError:
        raise HTTPException(
            status_code=404, detail=f"comparison state '{state}' is gone - upload the files again"
        ) from None
    if detail is None:
        raise HTTPException(status_code=404, detail=f"model '{model_id}' not found")
    return detail
