# dbt Lineage Graph — Interactive Lineage Explorer (PnC)

An interactive explorer for dbt lineage: open models straight from the graph, see the
compiled SQL, dependencies, schema and BigQuery deeplinks, and carve out a subgraph with
dbt selector syntax.

**Status:** AP-0 … AP-3 of [the hackathon brief](hackathon-lineage-explorer.md) are built and
tested. The hackathon starts at **AP-4** (backend search index, multi-project merge,
column-level lineage, BigQuery cost). See [What is left](#what-is-left-for-the-hackathon).

```
┌──────────────── front-end/ (React 18 + TypeScript + Vite + React Flow) ───────────────┐
│  GraphCanvas · ModelOverlay · SearchBar · Toolbar · Legend    state: one Zustand store │
└───────────────────────────────┬───────────────────────────────────────────────────────┘
                                │  REST / JSON — contract.md (v0)
┌───────────────────────────────┴──── back-end/ (FastAPI, uv) ───────────────────────────┐
│  loader (manifest + catalog) · GraphService · fuzzy search · BigQuery deeplink builder  │
└───────────────────────────────┬────────────────────────────────────────────────────────┘
                                │
         fixtures/pipelines.yaml → one manifest.json + catalog.json per pipeline
```

Front end and back end are strictly separated: they share nothing but the HTTP contract in
[`contract.md`](contract.md), typed on both sides (`back-end/app/schemas.py`,
`front-end/src/api/types.ts`). The frontend falls back to bundled mock data when the API is
down, so either side can be worked on alone.

---

## Quick start

```bash
./dev.sh                         # starts both: API on :8000, UI on http://localhost:5173
./dev.sh examples/pipelines.yaml # the full experience: 3 real dbt projects the backend builds itself
./dev.sh path/to/pipelines.yaml  # same, with your own pipelines (see pipelines.example.yaml)
```

`examples/` holds three real dbt-core 1.x projects (no data, DuckDB, BigQuery-compatible SQL)
with execution modes. The backend runs `dbt docs generate` for them through uv, so the first
start takes a few seconds per pipeline. See [examples/README.md](examples/README.md), and
[docs/pipeline-guide.md](docs/pipeline-guide.md) for how to set up a pipeline that reads well
(layers, dbt groups, cross-pipeline sources, execution modes).

Or separately:

```bash
cd back-end  && uv sync --group dev && uv run lineage-api --reload   # :8000, docs at /docs
cd front-end && npm install && npm run dev                           # :5173
```

The Vite dev server proxies `/api` to `127.0.0.1:8000`, so there is no CORS setup to do.

> **This machine has no system-wide Node.** A user-local Node 20 lives in `~/.local/node`.
> `./dev.sh` picks it up automatically; for manual npm commands run
> `export PATH="$HOME/.local/node/bin:$PATH"` first.

### Tests

```bash
cd back-end  && uv run pytest && uv run ruff check .
cd front-end && npm test
```

---

## Using it

| Action | How |
|---|---|
| Open a model | click a node, or search and press ⏎ |
| Search models | `/` or `Ctrl/Cmd+K`, typo tolerant (Fuse.js) |
| Search columns | switch the search toggle to **Columns** (hits `/api/search/columns`) |
| Focus the lineage | `F` cycles **dim → isolate → off**; the path keeps a stage-coloured ring, everything else fades and blurs |
| Select a subgraph | selector field: `+int_mfp_contracts+`, `tag:mfp`, `stage:out`, `2+out_claims_kpi_daily` |
| Copy a dbt command | **dbt run** button (toolbar = whole selection, overlay = one model) |
| Stage zones | **Stage zones** toggle or `L` — src / int / out as columns |
| Area select | Shift + drag, or toggle the box-select button for plain left drag |
| dbt tests & dq checks | **Tests** in the toolbar: each card lists its yaml tests (`not_null(pol_nr)`, …) and the singular tests (`tests/*.sql`, e.g. `dq_check_*`) appear as dashed nodes under the models they read; the overlay lists a model's tests. Try `./dev.sh examples/pipelines.yaml` |
| Mini-map | `M` |
| Zoom to fit | `Z` |
| Share a view | the URL carries `?model=…&tab=…&layout=…&focus=…&select=…` |
| Switch theme | sun / monitor / moon in the top bar — light, follow the system, dark (remembered per browser) |
| Stack execution modes | open the **pipelines** chip: tick several modes of a pipeline to stack them, the ★ one is in front (unticked modes are hidden). Every card gets mode tabs and offset back cards; models only in a back mode are dashed ghosts, `≠ SQL` marks models whose SQL differs. Click a tab to bring that mode to the front (the layout stays put). The **Code** tab shows each mode, **Side by side** or a **Diff**. Compare shows only the front modes |
| Export for documentation | **Export** in the top bar: PNG or SVG image, a Mermaid file (`.mmd`), or Mermaid copied as a Markdown block (GitHub, GitLab, Confluence, Notion). Exports what the canvas shows: filters and focus *isolate* apply, compare-mode colours are kept; images always show full-detail nodes |
| Compare with a dev state | **Compare** in the top bar: upload one pipeline's `manifest.json` (+ optional `catalog.json`) from a dev state and pick the pipeline it replaces. Nodes and edges turn green (added), yellow (modified) or red (removed); a changed node opens on a **Changes** tab with the field, column and SQL diff. **Select changes** + focus mode shows what the changes affect. Try it with `fixtures/dev_state/` (a dev version of `bestand_mfp`) |

---

## Feature coverage against the brief

**Prio 1 — complete**

| # | Feature | Where |
|---|---|---|
| 1.1 | Pan / zoom / zoom-to-fit / centre on click | `front-end/src/components/GraphCanvas.tsx` |
| 1.2 | Compiled SQL with highlighting + copy | `CodeViewer.tsx`, `GET /api/model/{id}` |
| 1.3 | Dependencies & dependents, clickable | `ModelOverlay.tsx`, inverted in `back-end/app/loader.py` |
| 1.4 | Focus mode (dim / isolate) | `graph/selectors.ts`, `GraphCanvas.tsx` |
| 1.5 | Fuzzy search | `SearchBar.tsx` (Fuse.js) + `GET /api/search` (rapidfuzz) |
| 1.6 | Materialization visible | badge + icon in `nodes/ModelNode.tsx` |
| 1.7 | Multi-selection with `+model+` | `graph/selectors.ts`, `Toolbar.tsx` |
| 1.8 | Larger, zoom-dependent labels | `ModelNode.tsx` + `.node--compact` |

**Prio 2 — 2.1 / 2.2 done, 2.4 prepared**

- 2.1 Schema tab with columns, types, descriptions (`SchemaTable.tsx`, merged from `catalog.json`).
- 2.2 Column search, server-side.
- 2.4 Cross-pipeline edges are rendered (dashed orange) and the loader already takes a *list*
  of dbt projects — only the config and a UI grouping are missing.
- 2.3 Column-level lineage: sqlglot parses each model's compiled SQL against the catalog
  schema (`back-end/app/column_lineage.py`). In the Schema tab, the ↑/↓ button on a column
  traces it: the traced columns appear as rows inside the nodes, column edges are coloured by
  kind (passthrough / rename / transform / aggregate) and the overlay lists every hop with its
  SQL expression. `GET /api/lineage/status` reports which models parsed.

**Look and feel** — light and dark themes, defaulting to the operating system setting and
overridable from the top bar. Both palettes are defined as CSS custom properties in
`front-end/src/styles/global.css`; stage colours have a per-theme variant so they keep
their contrast on a white canvas (`front-end/src/components/visual.tsx`).

**Prio 3 — 3.1, 3.2, 3.3, 3.4, 3.6 done**

BigQuery deeplink (table + prefilled query), stage zones, mini-map, area select & drag,
copy `dbt run`. 3.5 execution mode is carried through the API and shown in the overlay.

---

## What is left for the hackathon

Start at **AP-4** — everything it needs is in place:

1. **Server-side search as the primary path** — endpoints exist; decide when the client-side
   index stops scaling and switch `SearchBar` over.
2. **Lineage across pipelines (2.4)**: list the real pipelines in a `pipelines.yaml`
   (one dbt project each, see [contract.md §1.0](contract.md)). They are stitched together by
   output table name.
3. **Column-level lineage, next steps (2.3)** — *indirect* edges (columns used in `join` /
   `where` / `group by`), and checking the parser coverage on the real PnC artifacts
   (`GET /api/lineage/status`).
4. **BigQuery cost & execution metadata (4.2 / 3.5)** — an `INFORMATION_SCHEMA` adapter
   feeding new fields into `stats`.
5. **Real fixtures**: point `PIPELINES_CONFIG` at the real PnC pipelines and check that
   their `01_source / 02_intermediate / 03_output` folders resolve as expected.

Open points from section 8 of the brief, as decided here (change freely):
a pipeline is one dbt project (`project_name`), with layers `models/01_source` →
`02_intermediate` → `03_output`; stage from layer folder → name prefix → tag;
BigQuery deeplink to the node's own `database` unless `BQ_CONSOLE_PROJECT` is set;
`+model+` is both a visual selection *and* exportable as a `dbt run --select` string.

---

## Repository layout

```
contract.md                  API contract v0 — the only coupling between FE and BE
dev.sh                       start both servers
fixtures/                    synthetic PnC dbt artifacts + their generator (used by the tests)
examples/                    real dbt projects with execution modes (uv project, DuckDB)
back-end/                    FastAPI service (uv), see back-end/README.md
front-end/                   React + Vite app, see front-end/README.md
hackathon-lineage-explorer.md  the original brief
```

Bigger graph for a performance check:

```bash
python3 fixtures/generate_fixtures.py --scale 30 --out-dir /tmp/big   # 60 pipelines, ~690 models
PIPELINES_CONFIG=/tmp/big/pipelines.yaml uv run --directory back-end lineage-api
```
