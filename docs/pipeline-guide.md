# Setting up a dbt pipeline that reads well in the Lineage Explorer

Tips for teams who build or adapt a dbt project (a *pipeline*) so it looks clear and tells
its story in the Lineage Explorer. Everything here is plain dbt; the Explorer only reads
`manifest.json` + `catalog.json`. The projects in [examples/](../examples/) follow all of
it, so copy from there.

## What the Explorer draws, and what drives it

| You see | Comes from |
|---|---|
| **Columns** (one per layer) | the layer folder of the model, matched against `layers:` in `pipelines.yaml` |
| **Rows** (domains) in the lanes layout | the dbt **group** of each model |
| **Boxes** in the lanes layout | one per entry in `pipelines.yaml` (with 2+ pipelines in view) |
| Edges between pipelines | a **source** whose table name equals another pipeline's **output** |
| Badge + "Execution mode" in the overlay | `meta.execution_mode` (e.g. `daily`) |
| Search hits, filters | model names, tags, descriptions, column names |
| Schema tab, column types | `catalog.json` (from `dbt docs generate` against built tables) |
| Column lineage | the compiled SQL plus the catalog |
| Mode dropdown in the pipeline picker | `execution_modes` in `pipelines.yaml` |

## 1. Layout: layers, one folder each

```
models/
├── 01_source/        src   raw sources + other pipelines' outputs, cleaned 1:1
├── 02_intermediate/  int   joins, business logic - private to the pipeline
└── 03_output/        out   the public interface: what reports and other pipelines read
```

- The **folder** decides the stage. Which folders are layers is declared in
  `pipelines.yaml`, in flow order: the first layer imports, the last one is the public
  interface, anything between is internal. Declare them once at the top level, or per
  pipeline when a project uses another scheme (e.g. dbt-labs style `staging` /
  `intermediate` / `marts`, see `finance_controlling` in [examples/](../examples/pipelines.yaml)):

  ```yaml
  layers:
    - {name: src, label: Source, folders: [01_source], prefixes: [src_]}
    - {name: int, label: Intermediate, folders: [02_intermediate], prefixes: [int_]}
    - {name: out, label: Output, folders: [03_output], prefixes: [out_]}
  ```

  A numeric prefix (`01_`) is optional on either side. Without `layers:` the Explorer
  recognises `source` / `intermediate` / `output` (also `staging`, `marts`).
- Prefix the model names anyway (`src_`, `int_`, `out_`). It reads better in search, and
  with `prefixes:` it is the fallback for models outside the layer folders.
- Give each layer its own schema and keep it stable across environments, with a small
  `generate_schema_name` override (see [examples/bestand_mfp/macros](../examples/bestand_mfp/macros/generate_schema_name.sql)):

  ```yaml
  # dbt_project.yml
  models:
    dbt_pnc:
      01_source:       {+schema: mfp_source,       +materialized: view}
      02_intermediate: {+schema: mfp_intermediate, +materialized: table}
      03_output:       {+schema: mfp_output,       +materialized: table}
  ```

- **Only outputs leave the pipeline.** Other pipelines must never read the tables of your
  other layers: only models of the last layer can be link targets, so such a read shows up as an unlinked source.

## 2. dbt groups: the domain rows

Groups are what turn a long DAG into a readable map. In the lanes layout every group becomes
a horizontal band across the src → int → out columns, so you see at a glance which domain
does what in which layer.

**Choosing groups**

- Think *business domain / ownership*, not technical role: `contract`, `partner`,
  `premium`, `claims`, `reinsurance`, `finance`.
- **3–6 groups per pipeline.** One group is a single band (no gain); fifteen is noise.
- **Use the same name for the same domain in every pipeline.** Rows are matched by
  name, so `finance` models of `schaden_claims` and of `finance_controlling` share one band.
  Agree on a short shared list across teams, and do not mix `Finance` / `fin` / `finance`.
- A model belongs where its *output* belongs. `src_claims_mfp_premium` imports portfolio
  data but serves the finance figures, so it sits in `finance`.

**Defining them**

```yaml
# models/groups.yml
version: 2
groups:
  - name: contract
    owner: {name: Portfolio Team, email: portfolio@pnc.example}
  - name: premium
    owner: {name: Pricing Team, email: pricing@pnc.example}
```

Owners are good dbt practice. The Explorer does not show them yet.

**Assigning them**, per model in the layer's yml (explicit and easy to review):

```yaml
models:
  - name: int_mfp_premium_calc
    config: {group: premium, tags: [mfp, pricing], meta: {execution_mode: daily}}
```

or, when a whole folder is one domain, in `dbt_project.yml`: `+group: claims`.

- Leave `access` at its default (`protected`). `private` models cannot be referenced from
  another group, so your pipeline would stop compiling as soon as domains reference each other.
- **Sources** cannot have a dbt group. The Explorer puts a source in the group of most of
  its consumers; set `meta: {group: ...}` on the source to override that.
- Ungrouped models end up in a last "no group" band. Aim for none.

## 3. Connecting pipelines

A pipeline reads another pipeline's output by declaring that table as a **source**, and
imports it through a `src` model:

```yaml
# schaden_claims/models/01_source/_sources.yml
sources:
  - name: mfp_output                       # one source per upstream pipeline, named after it
    database: "{{ var('mfp_database', target.database) }}"
    schema: mfp_output
    tables:
      - name: out_mfp_contracts            # == the upstream model's table name (alias)
        columns:
          - {name: contract_id, data_type: STRING}
```

```sql
-- schaden_claims/models/01_source/src_claims_mfp_contracts.sql
select contract_id, partner_id, product_code, canton, annual_premium_chf
from {{ source('mfp_output', 'out_mfp_contracts') }}
```

- The link is made on the **table name only**; database and schema are ignored, since
  pipelines live in different GCP projects. So **output names must be unique across all
  pipelines**: prefix them with the pipeline's domain (`out_mfp_…`, `out_claims_…`). If a name
  matches several outputs, the source stays unlinked.
- Reading an output through a passthrough view named `<output>_v` also links.
- Always go `out` → source → `src` model, so the import is visible in the src column and
  the `int` layer only reads your own models. The Explorer does not flag an `int` model
  reading the source directly, but the graph then hides where data enters the pipeline.
- List the columns of imported tables (with `data_type`). That documents the contract and
  lets the column lineage continue across the pipeline boundary.

## 4. Documentation that pays off in the UI

- **Descriptions** on every model and on the columns that matter. They show in the overlay
  and are searchable. One sentence on *what* and *why* beats a paragraph on *how*.
- **Tags**: a pipeline tag (`mfp`), a role (`staging`, `core`, `kpi`, `public`), and flags
  like `pii`. Keep the vocabulary small and shared.
- **`meta.execution_mode`**: how often the model runs (`hourly`, `daily`, `weekly`,
  `monthly`). It is shown as a badge.
- **`meta.pipeline`** overrides the pipeline of a single node. You should rarely need it.
- Add the usual `unique` / `not_null` tests on keys. The Explorer ignores tests, but they
  belong in a well-kept project.

## 5. SQL the column lineage understands

The Explorer parses each model's compiled SQL (sqlglot) to trace columns. It handles CTEs,
joins, aggregates, `qualify`, ephemeral models and Jinja (it reads the compiled code), but
you get better results with:

- **Explicit column lists** instead of `select *` (a `*` resolves only when the upstream
  table is in the catalog).
- **Qualified columns in joins** (`contracts.partner_id`), so nothing is ambiguous.
- **A real catalog**: run `dbt docs generate` against a target where the tables exist.
  Without data, see section 7.
- Document **all** columns of an ephemeral model, or none. Ephemeral models never reach
  the catalog. (The Explorer completes partly documented ones from the SQL, but full docs
  are clearer.)
- Check *Lineage status* in the UI (or `GET /api/lineage/status`). It lists models the
  parser could not fully resolve, and why.

## 6. Execution modes

When dbt vars change what a pipeline builds (full vs. incremental load, month-end close,
gross vs. net), declare the combinations as modes. The Explorer then shows one mode at a
time and switches between them.

```yaml
# pipelines.yaml
- name: bestand_mfp
  project_dir: bestand_mfp
  dir: artifacts/bestand_mfp          # artifacts per mode go to <dir>/<mode>/
  default_mode: full
  execution_modes:
    full:          {vars: {full_mode: true,  monthly_mode: false}}
    incremental:   {vars: {full_mode: false, monthly_mode: false}}
    monthly_close: {vars: {full_mode: true,  monthly_mode: true}}
```

Make the modes visible in the lineage. If two modes produce the same graph, the only
difference is in the SQL.

- **Switch models on and off** with `enabled`:
  ```sql
  {{ config(enabled=var('monthly_mode')) }}
  ```
- **Switch sources** the same way, in yml. `as_bool` must be the **last** filter of the
  whole expression:
  ```yaml
  config:
    enabled: "{{ (not var('full_mode')) | as_bool }}"   # right
    # enabled: "{{ not (var('full_mode') | as_bool) }}" # wrong: always disabled
  ```
- **Switch dependencies** with a Jinja `if` around `ref()`. dbt only records the refs of
  the branch taken:
  ```sql
  {% if var('full_mode') %} from {{ ref('src_mfp_contracts') }}
  {% else %}                from {{ ref('src_mfp_contract_changes') }} {% endif %}
  ```
- **Switch materialization**: `materialized='table' if var('full_mode') else 'incremental'`.
- Keep the defaults in `dbt_project.yml` `vars:` equal to the `default_mode`, so a plain
  `dbt run` builds what the Explorer shows first.
- Name modes after what a business user would pick (`monthly_close`, `net_of_ri`), not
  after the vars.
- Modes can depend on each other across pipelines: in the examples,
  `finance_controlling`'s `plan_vs_actual` reads an output that only exists in
  `bestand_mfp`'s `monthly_close`. Document such pairs in the mode comments.

## 7. Without data: DuckDB, BigQuery-compatible

To get full artifacts (catalog included) without warehouse access, as the examples do:

1. Declare every source column with a `data_type` valid in both engines: `STRING`,
   `NUMERIC`, `INTEGER`, `DATE`, `TIMESTAMP`, `BOOLEAN`.
2. Add the `create_empty_sources()` macro as `on-run-start`. On DuckDB it creates the
   sources as empty tables; on other targets it does nothing.
3. Let the backend run `dbt run --empty --full-refresh` before `docs generate`
   (`prepare` in `pipelines.yaml`).

For SQL that runs on DuckDB and BigQuery alike, use dbt's cross-database macros
(`dbt.datediff`, `dbt.dateadd`, `dbt.date_trunc`, `dbt.listagg`, `dbt.type_*`), `x / nullif(y, 0)`
instead of `safe_divide`, and standard date literals (`date '9999-12-31'`). Keep a `duckdb`
and a `bigquery` target in `profiles.yml`, and make source databases configurable via vars
(`var('raw_database', target.database)`).

## Checklist

- [ ] Models in the layer folders declared in `pipelines.yaml` (e.g. `01_source` / `02_intermediate` / `03_output`), prefixed `src_` / `int_` / `out_`
- [ ] 3–6 groups from the shared domain list, defined with owners, every model assigned
- [ ] Output table names unique across all pipelines (domain prefix)
- [ ] Other pipelines' outputs imported as sources (named after the pipeline) through `src` models
- [ ] Descriptions on models and key columns; tags from the shared vocabulary; `meta.execution_mode`
- [ ] Explicit, qualified columns in SQL; Lineage status shows no failures
- [ ] `dbt docs generate` against built tables, so the catalog has column types
- [ ] Execution modes declared in `pipelines.yaml`, each with a visible difference, defaults matching
- [ ] Entry in `pipelines.yaml` with `name`, `project_dir` / `dir`, modes
