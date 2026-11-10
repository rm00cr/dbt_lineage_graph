"""FastAPI application — contract v0 (see ../contract.md)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .column_lineage import Direction
from .config import Settings
from .dbt_runner import GenerationUnsupportedError, JobRunningError
from .schemas import (
    ColumnLineageResponse,
    DiffResponse,
    GenerateRequest,
    GenerationJobInfo,
    GraphResponse,
    HealthResponse,
    LineageStatusResponse,
    MetaResponse,
    ModelDetail,
    PipelineInfo,
    SearchResponse,
    SetModeRequest,
    SetModesRequest,
)
from .service import (
    ArtifactError,
    GraphService,
    ModeUnavailableError,
    UnknownPipelineError,
    UnknownStateError,
)

API_DESCRIPTION = """
Interactive dbt Lineage Explorer — backend.

Reads dbt artifacts (`manifest.json` + `catalog.json`) and serves a slim lineage graph,
per-model details (compiled SQL, dependencies, schema) and fuzzy search, and compares the
running state with another state of the project (`POST /api/diff`).
"""


@lru_cache(maxsize=1)
def get_service() -> GraphService:
    service = GraphService(Settings.from_env())
    # artifacts that are not on disk yet are generated in the background (needs project_dir)
    service.generate_missing()
    return service


ServiceDep = Annotated[GraphService, Depends(get_service)]

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # build the graph and start generating missing artifacts right away, not on the first request
    if get_service not in app.dependency_overrides:
        get_service()
    yield


app = FastAPI(
    lifespan=lifespan,
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


@app.get("/api/pipelines", response_model=list[PipelineInfo], tags=["pipelines"])
def pipelines(service: ServiceDep) -> list[PipelineInfo]:
    """The configured pipelines with their execution modes and which mode is shown."""
    return service.pipelines_info()


@app.post("/api/pipelines/{name}/mode", response_model=PipelineInfo, tags=["pipelines"])
def set_pipeline_mode(service: ServiceDep, name: str, body: SetModeRequest) -> PipelineInfo:
    """Show another execution mode of a pipeline; every endpoint then reads that mode.

    Without artifacts on disk the mode is generated first (`pending_mode`), then shown."""
    try:
        return service.set_mode(name, body.mode)
    except UnknownPipelineError as error:
        raise HTTPException(status_code=404, detail=error.args[0]) from None
    except ModeUnavailableError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None


@app.post("/api/pipelines/{name}/modes", response_model=PipelineInfo, tags=["pipelines"])
def set_pipeline_modes(service: ServiceDep, name: str, body: SetModesRequest) -> PipelineInfo:
    """Show several execution modes of a pipeline stacked: `front` in front, the other
    `selected` modes behind it. The graph then carries `modes` / `front` / `sql_differs`.

    Missing back modes are generated in the background and join the stack when done."""
    try:
        return service.set_modes(name, body.selected, body.front)
    except UnknownPipelineError as error:
        raise HTTPException(status_code=404, detail=error.args[0]) from None
    except ModeUnavailableError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


def _generate(service: GraphService, name: str, mode: str | None) -> PipelineInfo:
    try:
        return service.generate(name, mode)
    except UnknownPipelineError as error:
        raise HTTPException(status_code=404, detail=error.args[0]) from None
    except GenerationUnsupportedError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    except JobRunningError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None


@app.post("/api/pipelines/{name}/generate", response_model=PipelineInfo, tags=["pipelines"])
def generate_pipeline(service: ServiceDep, name: str, body: GenerateRequest | None = None) -> PipelineInfo:
    """Regenerate a pipeline's artifacts in the background (`dbt docs generate`); for a
    pipeline with execution modes the shown mode, or `mode` from the body."""
    return _generate(service, name, body.mode if body else None)


@app.post("/api/pipelines/{name}/modes/{mode}/generate", response_model=PipelineInfo, tags=["pipelines"])
def generate_pipeline_mode(service: ServiceDep, name: str, mode: str) -> PipelineInfo:
    """Regenerate one execution mode of a pipeline in the background."""
    return _generate(service, name, mode)


@app.get("/api/jobs", response_model=list[GenerationJobInfo], tags=["pipelines"])
def jobs(service: ServiceDep) -> list[GenerationJobInfo]:
    """Background dbt runs: running ones and the recent finished ones, newest first."""
    return service.jobs()


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
    pipeline: Annotated[
        str | None,
        Form(description="pipelines.yaml name of the pipeline the upload replaces (default: match on project_name)"),
    ] = None,
) -> DiffResponse:
    """Compare the running state with an uploaded one: every node and edge gets a `change`."""
    manifest_bytes = await manifest.read()
    catalog_bytes = await catalog.read() if catalog is not None else None
    try:
        return service.compare(
            manifest_bytes,
            catalog_bytes or None,
            label=(label or "").strip() or manifest.filename or "uploaded state",
            pipeline=pipeline,
        )
    except ArtifactError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


@app.get("/api/model/{model_id:path}", response_model=ModelDetail, tags=["graph"])
def model_detail(
    service: ServiceDep,
    model_id: str,
    state: Annotated[str | None, Query(description="state_id of a comparison: read from that state")] = None,
    mode: Annotated[
        str | None, Query(description="execution mode of the model's pipeline to read it from")
    ] = None,
) -> ModelDetail:
    """Detail for the overlay. Accepts the dbt `unique_id` or a plain model name."""
    try:
        detail = service.model_detail(model_id, state=state, mode=mode)
    except UnknownStateError:
        raise HTTPException(
            status_code=404, detail=f"comparison state '{state}' is gone - upload the files again"
        ) from None
    except UnknownPipelineError as error:
        raise HTTPException(status_code=404, detail=error.args[0]) from None
    except ModeUnavailableError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    if detail is None:
        raise HTTPException(status_code=404, detail=f"model '{model_id}' not found")
    return detail
