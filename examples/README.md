# Example pipelines

Three real dbt projects that make up a small P&C analytics platform. They ship **without
data**: the backend builds them on an empty DuckDB file and runs `dbt docs generate`, so the
Lineage Explorer gets real manifests and catalogs (column types included), and every
execution mode produces a different lineage.

```bash
./dev.sh examples/pipelines.yaml      # from the repo root
```

uv creates the dbt environment ([pyproject.toml](pyproject.toml): dbt-core 1.x, dbt-duckdb)
on first use. On first start each pipeline's default mode is generated in the background;
watch the task indicator in the top bar. Generated artifacts go to `examples/artifacts/`
and are reused on later starts.

How to set up your own project the same way: [docs/pipeline-guide.md](../docs/pipeline-guide.md).

## The pipelines

```
bestand_mfp ──▶ schaden_claims ──▶ finance_controlling
     └──────────────────────────────────────▲
```

The layers (stage columns) are declared in `pipelines.yaml`: `bestand_mfp` and
`schaden_claims` use `models/01_source` → `02_intermediate` → `03_output` (the top-level
`layers:`), `finance_controlling` overrides them with `staging` → `intermediate` → `marts`
(`stg_` / `int_` / `mart_` models). Inside a layer, models sit in topic sub-folders
(e.g. `02_intermediate/contracts/`); these become the boxes of **Zones → Groups**, and a few
models stay directly in the layer folder to show its `(root)` box. All use dbt groups with owners, tags, `meta.execution_mode` (daily / hourly / ...),
descriptions and a few tests. All three are called `dbt_pnc`, as in production;
`pipelines.yaml` gives them their names. A pipeline reads another one's output by declaring
the table as a dbt source, and the Explorer links them by table name.

| Pipeline | Mode | Vars | What changes in the lineage |
|---|---|---|---|
| `bestand_mfp` (portfolio) | **full** | `full_mode: true` | contracts from the full export `raw_mfp.contracts` |
| | **incremental** | `full_mode: false` | change feed `raw_mfp.contract_changes` → `src_mfp_contract_changes` instead; `int_mfp_contracts` becomes incremental |
| | **monthly_close** | `full_mode: true, monthly_mode: true` | adds `int_mfp_month_end_snapshot` and `out_mfp_portfolio_monthly`; the premium report reads the snapshot |
| `schaden_claims` (claims) | **gross** | `include_reinsurance: false` | gross payments |
| | **net_of_ri** | `include_reinsurance: true` | adds `raw_claims.ri_recoveries`, `int_claims_net_payments`, `out_claims_ri_report`; the loss ratio is net |
| | **large_loss_watch** | `large_loss_threshold: 250000` | same graph, different SQL in `int_claims_cases` |
| `finance_controlling` (P&L) | **actuals** | `include_plan: false` | booked figures |
| | **plan_vs_actual** | `include_plan: true` | adds the premium plan, `int_fin_plan_vs_actual`, `mart_fin_plan_variance`, and reads `out_mfp_portfolio_monthly` |
| | **flat_allocation** | `expense_alloc: flat` | same graph, shared costs split equally |

**Modes across pipelines:** `finance_controlling` in *plan_vs_actual* reads
`out_mfp_portfolio_monthly`, which only exists while `bestand_mfp` shows *monthly_close*.
With any other `bestand_mfp` mode, that source stays unlinked in the graph. This is the kind
of dependency the mode switch is meant to make visible.

## How generation works (no data)

[pipelines.yaml](pipelines.yaml) sets, for all three pipelines:

```yaml
dbt:
  command: uv run --frozen --project {here} dbt   # {here} = this folder
  prepare:
    - run --empty --full-refresh
```

Per mode, the backend runs `dbt run --empty --full-refresh` and then `dbt docs generate`,
both with `--vars '<mode vars>'` and a target path of their own. Each project has an
`on-run-start` hook ([macros/create_empty_sources.sql](bestand_mfp/macros/create_empty_sources.sql)).
On DuckDB, the hook first creates every declared source as an empty table from the
`data_type`s in its sources yml. `--empty` then builds all models with zero rows, and
`docs generate` catalogs them.

Run a project by hand:

```bash
cd examples/bestand_mfp
uv run --project .. dbt run --empty --vars '{full_mode: false}'
uv run --project .. dbt docs generate --vars '{full_mode: false}'
```

## BigQuery

The SQL uses dbt's cross-database macros (`dbt.datediff`, `dbt.date_trunc`, `dbt.listagg`)
and types that both engines understand. To run against BigQuery:

```bash
uv sync --project examples --extra bigquery
gcloud auth application-default login
export DBT_TARGET=bigquery BQ_PROJECT=my-gcp-project      # see each profiles.yml
```

Then remove `prepare` from `pipelines.yaml`. `run --empty` would create empty tables in
the warehouse, and the sources are real tables there anyway. The `raw_database`,
`mfp_database` and `claims_database` vars point the sources at other GCP projects.
