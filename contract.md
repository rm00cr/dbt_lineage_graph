# API Contract v0 — dbt Lineage Explorer

> **Status:** implemented (AP-0 … AP-3). Single source of truth for the coupling between
> `front-end/` and `back-end/`. Every change here must be mirrored in
> `back-end/app/schemas.py` (Pydantic) **and** `front-end/src/api/types.ts` (TypeScript).

- **Base URL:** `http://localhost:8000` (configurable in the frontend via `VITE_API_BASE_URL`)
- **Encoding:** JSON, `snake_case` keys (same convention as the dbt artifacts themselves)
- **Errors:** standard FastAPI error body `{"detail": "..."}` with HTTP 404 / 422 / 500

---

## 1. Conventions

### 1.1 Stages (`src` | `int` | `out` | `other`)

Resolved by the backend in this order (open point #1 from the kick-off, now decided):

1. dbt **sources** → always `src`
2. **name prefix**: `src_` → `src`, `int_` → `int`, `out_` → `out`
3. **folder** in `original_file_path`: `staging`/`source` → `src`, `intermediate` → `int`,
   `marts`/`output`/`out` → `out`
4. **dbt tag** `stage:<src|int|out>` if present
5. fallback → `other`

Configurable through `STAGE_PREFIXES` / `STAGE_FOLDERS` in `back-end/app/config.py`.

### 1.2 Pipeline

`config.meta.pipeline` of the dbt node, else the first path segment under `models/`
(e.g. `models/bestand_mfp/...` → `bestand_mfp`). Used for *lineage across pipelines* (2.4).

### 1.3 Node ids

dbt `unique_id`, e.g. `model.pnc_analytics.int_mfp_contracts`,
`source.pnc_analytics.raw_mfp.contracts`. Ids are URL-encoded in `/api/model/{id}`.

---

## 2. Endpoints

| Method | Path | Purpose | Prio |
|---|---|---|---|
| `GET` | `/api/health` | liveness + which artifacts are loaded | — |
| `GET` | `/api/meta` | pipelines, stages, materializations, counts (toolbar filters) | 1 |
| `GET` | `/api/graph` | whole lineage graph, slim payload for rendering | 1.1 |
| `GET` | `/api/model/{id}` | model detail for the overlay (lazy) | 1.2, 1.3, 2.1, 3.1 |
| `GET` | `/api/search` | fuzzy search over model names | 1.5 |
| `GET` | `/api/search/columns` | search over column names | 2.2 |
| `POST` | `/api/reload` | re-read the artifacts from disk after a fresh `dbt docs generate` | — |

### 2.1 `GET /api/graph`

Query params (all optional): `pipeline` (repeatable), `stage` (repeatable), `include_sources` (default `true`).

```jsonc
{
  "nodes": [
    {
      "id": "model.pnc_analytics.int_mfp_contracts",
      "name": "int_mfp_contracts",
      "stage": "int",                       // src | int | out | other
      "materialization": "table",           // table | view | incremental | ephemeral | source
      "pipeline": "bestand_mfp",
      "resource_type": "model",             // model | source
      "schema_name": "mfp_intermediate",
      "database": "pnc-analytics-prd",
      "description": "One row per contract …",
      "tags": ["mfp", "core"],
      "column_count": 11,
      "execution_mode": "daily"             // from config.meta.execution_mode (3.5), may be null
    }
  ],
  "edges": [
    {
      "id": "model.pnc_analytics.src_mfp_contracts->model.pnc_analytics.int_mfp_contracts",
      "source": "model.pnc_analytics.src_mfp_contracts",
      "target": "model.pnc_analytics.int_mfp_contracts",
      "cross_pipeline": false
    }
  ],
  "stats": {
    "node_count": 25,
    "edge_count": 30,
    "pipelines": ["bestand_mfp", "schaden_claims"],
    "stages": ["src", "int", "out"],
    "materializations": ["view", "table", "incremental", "ephemeral", "source"]
  }
}
```

### 2.2 `GET /api/model/{id}`

```jsonc
{
  "id": "model.pnc_analytics.int_mfp_contracts",
  "name": "int_mfp_contracts",
  "stage": "int",
  "materialization": "table",
  "pipeline": "bestand_mfp",
  "resource_type": "model",
  "description": "…",
  "tags": ["mfp", "core"],
  "schema_name": "mfp_intermediate",
  "database": "pnc-analytics-prd",
  "alias": "int_mfp_contracts",
  "original_file_path": "models/bestand_mfp/intermediate/int_mfp_contracts.sql",
  "execution_mode": "daily",
  "compiled_code": "select …",              // null for sources
  "raw_code": "{{ config(…) }} select …",   // null for sources
  "dependencies": [                          // direct upstreams, 1.3
    { "id": "model.pnc_analytics.src_mfp_contracts", "name": "src_mfp_contracts",
      "stage": "src", "materialization": "view", "pipeline": "bestand_mfp",
      "resource_type": "model" }
  ],
  "dependents": [ /* same shape — direct downstreams, 1.3 */ ],
  "columns": [                               // 2.1, from catalog.json
    { "name": "contract_id", "type": "STRING", "description": "…", "index": 1 }
  ],
  "stats": { "row_count": 184233, "size_bytes": 20480000 },   // nullable, from catalog
  "bigquery": {                              // 3.1 — null for sources/ephemeral or non-BQ adapters
    "project": "pnc-analytics-prd",
    "dataset": "mfp_intermediate",
    "table": "int_mfp_contracts",
    "console_url": "https://console.cloud.google.com/bigquery?project=…&ws=…", // opens the table
    "query_url": "https://console.cloud.google.com/bigquery?project=…&q=…"     // editor, prefilled
  },
  "dbt_run_command": "dbt run --select int_mfp_contracts"     // 3.6
}
```

### 2.3 `GET /api/search?q=…&limit=20`

```jsonc
{
  "query": "contrcts",
  "results": [
    { "id": "model.pnc_analytics.int_mfp_contracts", "name": "int_mfp_contracts",
      "stage": "int", "materialization": "table", "pipeline": "bestand_mfp",
      "resource_type": "model", "score": 0.93, "matched_on": "name" }
  ]
}
```

### 2.4 `GET /api/search/columns?q=…&limit=50`

```jsonc
{
  "query": "premium",
  "results": [
    { "id": "model.pnc_analytics.out_mfp_premium_report", "name": "out_mfp_premium_report",
      "stage": "out", "materialization": "table", "pipeline": "bestand_mfp",
      "resource_type": "model", "score": 1.0, "matched_on": "column",
      "column": { "name": "annual_premium_chf", "type": "NUMERIC", "description": "…", "index": 4 } }
  ]
}
```

---

## 3. Frontend-only concepts (no API involved)

- **Focus mode (1.4)** — upstream/downstream closure of the selection is computed in the
  browser from `/api/graph` (`front-end/src/graph/selectors.ts`).
- **dbt selector syntax (1.7)** — `+model+`, `model+`, `+model`, `2+model`, `model+3`,
  `tag:mfp`, `stage:out`, `pipeline:schaden_claims`; space = union, comma = intersection
  (dbt semantics). Parsed and
  resolved client-side; the resolved selector string is shown so it can be copied into a
  real `dbt run` / `dbt build` call.
- **Layout** — dagre, left-to-right, computed client-side so the backend stays stateless.
- **Shareable view** — the UI keeps `?model=<id>&tab=<overview|code|schema|lineage>&layout=<dag|lanes>&focus=<off|dim|isolate>&select=<selector>`
  in the address bar and restores it on load. Purely client-side.

---

## 4. Not in v0 (hackathon backlog → AP-4)

| Topic | Note |
|---|---|
| Column-level lineage (2.3) | needs sqlglot parsing → new endpoint `GET /api/lineage/column/{model}/{column}` |
| Multi-project merge (2.4) | loader already accepts a **list** of artifact pairs; only config + UI grouping missing |
| BQ cost / `INFORMATION_SCHEMA` (4.2) | new adapter, new `stats` fields |
| Server-side search as the primary path | endpoints exist; the UI currently prefers client-side Fuse.js for latency |
