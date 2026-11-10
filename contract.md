# API Contract v0 — dbt Lineage Explorer

> **Status:** implemented (AP-0 … AP-3). Single source of truth for the coupling between
> `front-end/` and `back-end/`. Every change here must be mirrored in
> `back-end/app/schemas.py` (Pydantic) **and** `front-end/src/api/types.ts` (TypeScript).

- **Base URL:** `http://localhost:8000` (configurable in the frontend via `VITE_API_BASE_URL`)
- **Encoding:** JSON, `snake_case` keys (same convention as the dbt artifacts themselves)
- **Errors:** standard FastAPI error body `{"detail": "..."}` with HTTP 404 / 422 / 500

---

## 1. Conventions

### 1.0 Pipelines and layers — the model this tool assumes

A **pipeline is one dbt project**, delivered as its own `manifest.json` + `catalog.json`
(`dbt docs generate`). Every pipeline is laid out in three layers:

```
models/
├── 01_source/        src  imports: raw sources and other pipelines' outputs
├── 02_intermediate/  int  internal to the pipeline
└── 03_output/        out  the pipeline's public interface
```

Which pipelines exist and where their artifacts are is declared in a YAML file
(`PIPELINES_CONFIG`, default `fixtures/pipelines.yaml`):

```yaml
pipelines:
  - name: bestand_mfp                    # optional, default: manifest project_name
    dir: bestand_mfp                     # manifest.json (+ catalog.json) inside
  - name: schaden_claims
    manifest: /ci/claims/target/manifest.json
    catalog: /ci/claims/target/catalog.json
```

**Across pipelines.** A pipeline reads another pipeline's output by declaring that table
as a dbt **source** (in `01_source`). Separate manifests do not reference each other, so the
backend links them on the **table name only** (source `identifier` = model `alias`). Database
and dataset are ignored on purpose, because pipelines are deployed to different GCP projects /
datasets. **Assumption: output table names are unique across all pipelines.** If a name still
matches several models, `out` models win; if that is still ambiguous, the source stays
unlinked and the backend logs a warning. The resulting edge is
`upstream out model -> imported source (src)`, with `cross_pipeline: true`.
Column lineage maps the columns of that edge 1:1 (`passthrough`).

### 1.1 Stages (`src` | `int` | `out` | `other`)

Resolved by the backend in this order:

1. dbt **sources** → always `src`
2. **layer folder** in `original_file_path`, ignoring a numeric prefix: `01_source` →
   `src`, `02_intermediate` → `int`, `03_output` → `out` (also `staging`, `marts`, …)
3. **name prefix** for models outside the layer folders: `src_`/`stg_` → `src`, `int_` →
   `int`, `out_`/`mart_` → `out`
4. **dbt tag** `stage:<src|int|out>` if present
5. fallback → `other`

Configurable through `STAGE_FOLDERS` / `STAGE_PREFIXES` in `back-end/app/config.py`.

### 1.2 Pipeline

The `name` of the node's entry in the pipelines YAML, else the `metadata.project_name` of
its manifest (see 1.0). `config.meta.pipeline` on a single node overrides both. Used for *lineage across pipelines* (2.4).

### 1.2b Group (domain)

`group` on `GraphNode` / `ModelDetail` (nullable), plus `groups` in `/api/graph` stats and
`/api/meta`. Models: the native dbt `group` (`config.group`, defined under `groups:` in yml).
Sources cannot have a dbt group: explicit `meta.group` on the source, else the group most of
its direct consumers belong to (ties alphabetical), else `null`. The stage-lanes layout draws
one horizontal row per group (ungrouped nodes last); without any groups it is a single row.
The zones toggle picks stages only / stages × groups / groups only (`?zones=stages|groups`),
and *split by pipeline* (`?split=pipeline`) gives every pipeline its own grid in its own box.
It assumes the convention that only a pipeline's outputs feed other pipelines (into a src
model): a consuming pipeline is placed right of the pipelines it reads from, independent
pipelines are stacked in the same column (frontend only, no API change).

### 1.2c Pipeline boundary convention

Only a pipeline's outputs may feed another pipeline, imported through a src model:
cross-pipeline edges must be `out -> src`. The frontend flags the rest
(`front-end/src/graph/boundary.ts`): `internal` (upstream is not an `out` model) and
`skips-src` (an output read by a non-`src` model). Edges from dbt sources never count. The
fixtures follow the convention
(`out_mfp_* -> source bestand_mfp.out_mfp_* -> src_claims_mfp_*`).

### 1.3 Node ids

dbt `unique_id`, e.g. `model.bestand_mfp.int_mfp_contracts`,
`source.bestand_mfp.raw_mfp.contracts`. Ids are URL-encoded in `/api/model/{id}`.

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
| `GET` | `/api/lineage/column` | column-level lineage of one column (origins / impact) | 2.3 |
| `GET` | `/api/lineage/status` | which models the SQL parser understood (coverage) | 2.3 |
| `POST` | `/api/reload` | re-read the artifacts from disk after a fresh `dbt docs generate` | — |

### 2.1 `GET /api/graph`

Query params (all optional): `pipeline` (repeatable), `stage` (repeatable), `include_sources` (default `true`).

```jsonc
{
  "nodes": [
    {
      "id": "model.bestand_mfp.int_mfp_contracts",
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
      "id": "model.bestand_mfp.src_mfp_contracts->model.bestand_mfp.int_mfp_contracts",
      "source": "model.bestand_mfp.src_mfp_contracts",
      "target": "model.bestand_mfp.int_mfp_contracts",
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
  "id": "model.bestand_mfp.int_mfp_contracts",
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
  "original_file_path": "models/02_intermediate/int_mfp_contracts.sql",
  "execution_mode": "daily",
  "compiled_code": "select …",              // null for sources
  "raw_code": "{{ config(…) }} select …",   // null for sources
  "dependencies": [                          // direct upstreams, 1.3
    { "id": "model.bestand_mfp.src_mfp_contracts", "name": "src_mfp_contracts",
      "stage": "src", "materialization": "view", "pipeline": "bestand_mfp",
      "resource_type": "model" }
  ],
  "dependents": [ /* same shape — direct downstreams, 1.3 */ ],
  "columns": [                               // 2.1, from catalog.json
    { "name": "contract_id", "type": "STRING", "description": "…", "index": 1,
      "upstream_count": 1, "downstream_count": 2 }   // direct column-lineage edges (2.3),
                                                    // null if the model could not be parsed
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
    { "id": "model.bestand_mfp.int_mfp_contracts", "name": "int_mfp_contracts",
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
    { "id": "model.bestand_mfp.out_mfp_premium_report", "name": "out_mfp_premium_report",
      "stage": "out", "materialization": "table", "pipeline": "bestand_mfp",
      "resource_type": "model", "score": 1.0, "matched_on": "column",
      "column": { "name": "annual_premium_chf", "type": "NUMERIC", "description": "…", "index": 4 } }
  ]
}
```

---

### 2.5 `GET /api/lineage/column?model=…&column=…&direction=both&depth=…`

Column-level lineage (2.3). `model` is the dbt `unique_id` or a plain model name, `column` is
case-insensitive. `direction`: `up` (origins), `down` (impact) or `both` (default). `depth`:
max hops (1–50), omit for the full closure. The ids are query params (not path segments)
because `/api/model/{id:path}` already swallows slashes. 404 for an unknown model/column.

```jsonc
{
  "root": { "model_id": "model.schaden_claims.out_pnc_combined_ratio",
            "model_name": "out_pnc_combined_ratio", "column": "incurred_chf",
            "type": "NUMERIC", "distance": 0 },
  "direction": "up",
  "depth": null,
  "nodes": [ /* same shape as root; distance = hops from the root */ ],
  "edges": [
    { "id": "model…int_claims_loss_ratio.paid_chf->model…out_pnc_combined_ratio.incurred_chf",
      "source_model": "model.schaden_claims.int_claims_loss_ratio", "source_column": "paid_chf",
      "target_model": "model.schaden_claims.out_pnc_combined_ratio", "target_column": "incurred_chf",
      "kind": "aggregate",                    // passthrough | rename | transform | aggregate
      "expression": "sum(`l`.`paid_chf` + `l`.`reserve_chf`)" }   // first non-trivial SQL on the path
  ],
  "warnings": []                              // e.g. "int_x: lineage partial - relations not found …"
}
```

How it is computed (`back-end/app/column_lineage.py`): every model's `compiled_code` is parsed
with **sqlglot** in the adapter's dialect and qualified against the catalog schema (needed for
`select *`, `using (…)` and unqualified columns). Models are processed in topological order; a
model without catalog columns contributes the columns of its own SQL. dbt's
`__dbt__cte__<ephemeral>` CTEs are kept as a hop to the ephemeral model. Only *value* lineage
is reported: columns used in `join` / `where` / `group by` are not edges (yet).

### 2.6 `GET /api/lineage/status`

```jsonc
{
  "dialect": "bigquery",
  "coverage": 1.0,                            // (ok + partial) / models with SQL
  "edge_count": 169,
  "counts": { "ok": 19, "partial": 0, "failed": 0, "skipped": 0 },
  "models": [ { "model_id": "…", "model_name": "…", "status": "ok", "error": null, "warnings": [] } ]
}
```

`partial` = parsed, but some columns or relations could not be resolved; `failed` = SQL not
parseable (the error is included); `skipped` = no compiled SQL.

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
- **Shareable view** — the UI keeps `?model=<id>&tab=<overview|code|schema|lineage>&layout=<dag|lanes>&focus=<off|dim|isolate>&select=<selector>&col=<model id>|<column>&coldir=<up|down>`
  in the address bar and restores it on load. Purely client-side.

---

## 4. Not in v0 (hackathon backlog → AP-4)

| Topic | Note |
|---|---|
| Column-level lineage: indirect edges | `join` / `where` / `group by` columns as a separate edge type |
| Multi-project merge (2.4) | loader already accepts a **list** of artifact pairs; only config + UI grouping missing |
| BQ cost / `INFORMATION_SCHEMA` (4.2) | new adapter, new `stats` fields |
| Server-side search as the primary path | endpoints exist; the UI currently prefers client-side Fuse.js for latency |
