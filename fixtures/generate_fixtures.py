#!/usr/bin/env python3
"""Generate realistic dbt artifacts for the Lineage Explorer.

The fixture models a small PnC (property & casualty) analytics setup with two pipelines
(`bestand_mfp` = portfolio, `schaden_claims` = claims). As in production, every pipeline is
its own dbt project with its own manifest.json + catalog.json, laid out as
models/01_source, models/02_intermediate, models/03_output. `schaden_claims` reads outputs of
`bestand_mfp` by declaring them as dbt sources; the backend stitches them by table name.
Both projects are called `dbt_pnc` (as in production); pipelines.yaml names them.

Output: <out-dir>/<pipeline>/{manifest,catalog}.json and <out-dir>/pipelines.yaml

Usage
-----
    python3 fixtures/generate_fixtures.py                 # write the two pipelines
    python3 fixtures/generate_fixtures.py --scale 20      # 20x synthetic clones (perf tests)
    python3 fixtures/generate_fixtures.py --out-dir /tmp/big
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Like production: every pipeline is a dbt project with the SAME project_name; the
# pipeline identity lives only in pipelines.yaml (`name`).
DBT_PROJECT = "dbt_pnc"
DATABASE = "pnc-analytics-prd"
RAW_DATABASE = "pnc-raw-prd"
DBT_VERSION = "1.8.7"
GENERATED_AT = "2026-10-27T21:14:09.482173Z"

# --------------------------------------------------------------------------------------
# Sources
# --------------------------------------------------------------------------------------

SOURCES: list[dict[str, Any]] = [
    {
        "source_name": "raw_mfp",
        "name": "contracts",
        "description": "Raw contract header export from the MFP policy system (daily full load).",
        "pipeline": "bestand_mfp",
        "columns": [
            ("contract_id", "STRING", "Technical contract key from MFP."),
            ("partner_id", "STRING", "Policy holder reference."),
            ("product_code", "STRING", "PnC product code, e.g. MOT, HOU, LIA."),
            ("valid_from", "DATE", "Start of the contract version."),
            ("valid_to", "DATE", "End of the contract version, 9999-12-31 if open."),
            ("status_code", "STRING", "Raw status code of the contract version."),
            ("annual_premium", "NUMERIC", "Gross annual premium in CHF."),
            ("load_ts", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 4_812_004,
        "bytes": 1_204_318_208,
    },
    {
        "source_name": "raw_mfp",
        "name": "partners",
        "description": "Raw partner / policy holder master data.",
        "pipeline": "bestand_mfp",
        "columns": [
            ("partner_id", "STRING", "Technical partner key."),
            ("partner_type", "STRING", "P = person, C = company."),
            ("birth_date", "DATE", "Birth date for natural persons."),
            ("postal_code", "STRING", "Postal code of the main address."),
            ("canton", "STRING", "Swiss canton code."),
            ("language_code", "STRING", "Correspondence language."),
            ("load_ts", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 2_104_551,
        "bytes": 402_653_184,
    },
    {
        "source_name": "raw_mfp",
        "name": "coverages",
        "description": "Raw coverage lines per contract (one row per covered risk).",
        "pipeline": "bestand_mfp",
        "columns": [
            ("coverage_id", "STRING", "Technical coverage key."),
            ("contract_id", "STRING", "Parent contract."),
            ("risk_code", "STRING", "Covered risk, e.g. THEFT, FIRE, GLASS."),
            ("sum_insured", "NUMERIC", "Sum insured in CHF."),
            ("deductible", "NUMERIC", "Deductible in CHF."),
            ("tariff_code", "STRING", "Applied tariff."),
            ("valid_from", "DATE", "Start of the coverage version."),
            ("load_ts", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 11_904_776,
        "bytes": 2_952_790_016,
    },
    {
        "source_name": "raw_mfp",
        "name": "tariffs",
        "description": "Tariff master data incl. factors per risk and region.",
        "pipeline": "bestand_mfp",
        "columns": [
            ("tariff_code", "STRING", "Tariff key."),
            ("risk_code", "STRING", "Risk the tariff applies to."),
            ("region_factor", "NUMERIC", "Regional loading factor."),
            ("base_rate", "NUMERIC", "Base rate per 1000 CHF sum insured."),
            ("valid_from", "DATE", "Start of validity."),
        ],
        "rows": 18_442,
        "bytes": 2_097_152,
    },
    {
        "source_name": "raw_claims",
        "name": "claims",
        "description": "Raw claim cases from the claims handling system.",
        "pipeline": "schaden_claims",
        "columns": [
            ("claim_id", "STRING", "Technical claim key."),
            ("contract_id", "STRING", "Contract the claim was reported on."),
            ("risk_code", "STRING", "Affected risk."),
            ("loss_date", "DATE", "Date of loss."),
            ("report_date", "DATE", "Date the claim was reported."),
            ("claim_status", "STRING", "Raw status, e.g. OPEN, CLOSED, REOPENED."),
            ("reserve_amount", "NUMERIC", "Current case reserve in CHF."),
            ("load_ts", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 1_284_332,
        "bytes": 318_767_104,
    },
    {
        "source_name": "raw_claims",
        "name": "payments",
        "description": "Raw claim payment transactions (indemnity, expenses, recoveries).",
        "pipeline": "schaden_claims",
        "columns": [
            ("payment_id", "STRING", "Technical payment key."),
            ("claim_id", "STRING", "Parent claim."),
            ("payment_date", "DATE", "Value date of the payment."),
            ("payment_type", "STRING", "INDEMNITY | EXPENSE | RECOVERY."),
            ("amount", "NUMERIC", "Signed amount in CHF."),
            ("load_ts", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 3_942_118,
        "bytes": 734_003_200,
    },
]

# --------------------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------------------
# (name, pipeline, folder, materialization, execution_mode, tags, description, deps, sql, columns)

MODELS: list[dict[str, Any]] = [
    # ---------------------------- bestand_mfp / 01_source ----------------------------
    {
        "name": "src_mfp_contracts",
        "pipeline": "bestand_mfp",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "daily",
        "tags": ["mfp", "staging"],
        "description": "Cleaned contract versions: renamed columns, typed, technical records removed.",
        "deps": ["source:raw_mfp.contracts"],
        "sql": """select
    contract_id,
    partner_id,
    product_code,
    valid_from,
    nullif(valid_to, date '9999-12-31')          as valid_to,
    case status_code
        when 'A' then 'active'
        when 'C' then 'cancelled'
        when 'S' then 'suspended'
        else 'unknown'
    end                                          as contract_status,
    annual_premium                               as annual_premium_chf,
    load_ts                                      as _loaded_at
from {{ source('raw_mfp', 'contracts') }}
where contract_id is not null""",
        "columns": [
            ("contract_id", "STRING", "Technical contract key."),
            ("partner_id", "STRING", "Policy holder reference."),
            ("product_code", "STRING", "PnC product code."),
            ("valid_from", "DATE", "Start of the contract version."),
            ("valid_to", "DATE", "End of the contract version, null if open."),
            ("contract_status", "STRING", "Harmonised status: active | cancelled | suspended."),
            ("annual_premium_chf", "NUMERIC", "Gross annual premium in CHF."),
            ("_loaded_at", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 4_812_004,
        "bytes": 0,
    },
    {
        "name": "src_mfp_partners",
        "pipeline": "bestand_mfp",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "daily",
        "tags": ["mfp", "staging"],
        "description": "Cleaned partner master data incl. derived age band.",
        "deps": ["source:raw_mfp.partners"],
        "sql": """select
    partner_id,
    case partner_type when 'P' then 'person' when 'C' then 'company' end as partner_type,
    birth_date,
    date_diff(current_date(), birth_date, year)                          as age_years,
    postal_code,
    canton,
    lower(language_code)                                                 as language_code,
    load_ts                                                              as _loaded_at
from {{ source('raw_mfp', 'partners') }}""",
        "columns": [
            ("partner_id", "STRING", "Technical partner key."),
            ("partner_type", "STRING", "person | company."),
            ("birth_date", "DATE", "Birth date for natural persons."),
            ("age_years", "INT64", "Age in completed years."),
            ("postal_code", "STRING", "Postal code of the main address."),
            ("canton", "STRING", "Swiss canton code."),
            ("language_code", "STRING", "Correspondence language, lower case."),
            ("_loaded_at", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 2_104_551,
        "bytes": 0,
    },
    {
        "name": "src_mfp_coverages",
        "pipeline": "bestand_mfp",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "daily",
        "tags": ["mfp", "staging"],
        "description": "Cleaned coverage lines per contract.",
        "deps": ["source:raw_mfp.coverages"],
        "sql": """select
    coverage_id,
    contract_id,
    risk_code,
    sum_insured   as sum_insured_chf,
    deductible    as deductible_chf,
    tariff_code,
    valid_from,
    load_ts       as _loaded_at
from {{ source('raw_mfp', 'coverages') }}
where sum_insured > 0""",
        "columns": [
            ("coverage_id", "STRING", "Technical coverage key."),
            ("contract_id", "STRING", "Parent contract."),
            ("risk_code", "STRING", "Covered risk."),
            ("sum_insured_chf", "NUMERIC", "Sum insured in CHF."),
            ("deductible_chf", "NUMERIC", "Deductible in CHF."),
            ("tariff_code", "STRING", "Applied tariff."),
            ("valid_from", "DATE", "Start of the coverage version."),
            ("_loaded_at", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 11_721_004,
        "bytes": 0,
    },
    {
        "name": "src_mfp_tariffs",
        "pipeline": "bestand_mfp",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "weekly",
        "tags": ["mfp", "staging", "reference"],
        "description": "Tariff reference data, deduplicated on (tariff_code, risk_code, valid_from).",
        "deps": ["source:raw_mfp.tariffs"],
        "sql": """select distinct
    tariff_code,
    risk_code,
    region_factor,
    base_rate,
    valid_from
from {{ source('raw_mfp', 'tariffs') }}""",
        "columns": [
            ("tariff_code", "STRING", "Tariff key."),
            ("risk_code", "STRING", "Risk the tariff applies to."),
            ("region_factor", "NUMERIC", "Regional loading factor."),
            ("base_rate", "NUMERIC", "Base rate per 1000 CHF sum insured."),
            ("valid_from", "DATE", "Start of validity."),
        ],
        "rows": 18_442,
        "bytes": 0,
    },
    # -------------------------- bestand_mfp / 02_intermediate --------------------------
    {
        "name": "int_mfp_contracts",
        "pipeline": "bestand_mfp",
        "folder": "02_intermediate",
        "materialized": "table",
        "execution_mode": "daily",
        "tags": ["mfp", "core"],
        "description": "Contract versions enriched with partner attributes. Core entity of the portfolio pipeline.",
        "deps": ["src_mfp_contracts", "src_mfp_partners"],
        "sql": """with contracts as (
    select * from {{ ref('src_mfp_contracts') }}
),

partners as (
    select * from {{ ref('src_mfp_partners') }}
)

select
    c.contract_id,
    c.partner_id,
    c.product_code,
    c.contract_status,
    c.valid_from,
    c.valid_to,
    c.annual_premium_chf,
    p.partner_type,
    p.age_years,
    p.canton,
    p.language_code
from contracts c
left join partners p using (partner_id)""",
        "columns": [
            ("contract_id", "STRING", "Technical contract key."),
            ("partner_id", "STRING", "Policy holder reference."),
            ("product_code", "STRING", "PnC product code."),
            ("contract_status", "STRING", "active | cancelled | suspended."),
            ("valid_from", "DATE", "Start of the contract version."),
            ("valid_to", "DATE", "End of the contract version."),
            ("annual_premium_chf", "NUMERIC", "Gross annual premium in CHF."),
            ("partner_type", "STRING", "person | company."),
            ("age_years", "INT64", "Age of the policy holder."),
            ("canton", "STRING", "Swiss canton code."),
            ("language_code", "STRING", "Correspondence language."),
        ],
        "rows": 4_812_004,
        "bytes": 1_073_741_824,
    },
    {
        "name": "int_mfp_coverages",
        "pipeline": "bestand_mfp",
        "folder": "02_intermediate",
        "materialized": "incremental",
        "execution_mode": "daily",
        "tags": ["mfp", "core"],
        "description": "Coverage lines joined to their tariff, incrementally loaded on valid_from.",
        "deps": ["src_mfp_coverages", "src_mfp_tariffs"],
        "sql": """with coverages as (
    select * from {{ ref('src_mfp_coverages') }}
    {% if is_incremental() %}
    where valid_from >= (select max(valid_from) from {{ this }})
    {% endif %}
),

tariffs as (
    select * from {{ ref('src_mfp_tariffs') }}
)

select
    cov.coverage_id,
    cov.contract_id,
    cov.risk_code,
    cov.sum_insured_chf,
    cov.deductible_chf,
    cov.tariff_code,
    cov.valid_from,
    t.region_factor,
    t.base_rate
from coverages cov
left join tariffs t
    on cov.tariff_code = t.tariff_code
   and cov.risk_code  = t.risk_code""",
        "columns": [
            ("coverage_id", "STRING", "Technical coverage key."),
            ("contract_id", "STRING", "Parent contract."),
            ("risk_code", "STRING", "Covered risk."),
            ("sum_insured_chf", "NUMERIC", "Sum insured in CHF."),
            ("deductible_chf", "NUMERIC", "Deductible in CHF."),
            ("tariff_code", "STRING", "Applied tariff."),
            ("valid_from", "DATE", "Start of the coverage version."),
            ("region_factor", "NUMERIC", "Regional loading factor."),
            ("base_rate", "NUMERIC", "Base rate per 1000 CHF sum insured."),
        ],
        "rows": 11_721_004,
        "bytes": 2_684_354_560,
    },
    {
        "name": "int_mfp_contract_coverage",
        "pipeline": "bestand_mfp",
        "folder": "02_intermediate",
        "materialized": "table",
        "execution_mode": "daily",
        "tags": ["mfp", "core"],
        "description": "Contract x coverage grain: the central fact table of the portfolio pipeline.",
        "deps": ["int_mfp_contracts", "int_mfp_coverages"],
        "sql": """select
    c.contract_id,
    cov.coverage_id,
    c.partner_id,
    c.product_code,
    cov.risk_code,
    c.contract_status,
    c.canton,
    cov.sum_insured_chf,
    cov.deductible_chf,
    cov.region_factor,
    cov.base_rate,
    c.annual_premium_chf,
    greatest(c.valid_from, cov.valid_from) as valid_from
from {{ ref('int_mfp_contracts') }} c
inner join {{ ref('int_mfp_coverages') }} cov using (contract_id)""",
        "columns": [
            ("contract_id", "STRING", "Technical contract key."),
            ("coverage_id", "STRING", "Technical coverage key."),
            ("partner_id", "STRING", "Policy holder reference."),
            ("product_code", "STRING", "PnC product code."),
            ("risk_code", "STRING", "Covered risk."),
            ("contract_status", "STRING", "active | cancelled | suspended."),
            ("canton", "STRING", "Swiss canton code."),
            ("sum_insured_chf", "NUMERIC", "Sum insured in CHF."),
            ("deductible_chf", "NUMERIC", "Deductible in CHF."),
            ("region_factor", "NUMERIC", "Regional loading factor."),
            ("base_rate", "NUMERIC", "Base rate per 1000 CHF sum insured."),
            ("annual_premium_chf", "NUMERIC", "Gross annual premium in CHF."),
            ("valid_from", "DATE", "Start of the combined version."),
        ],
        "rows": 11_690_233,
        "bytes": 3_221_225_472,
    },
    {
        "name": "int_mfp_premium_calc",
        "pipeline": "bestand_mfp",
        "folder": "02_intermediate",
        "materialized": "ephemeral",
        "execution_mode": "daily",
        "tags": ["mfp", "calculation"],
        "description": "Technical premium per coverage (ephemeral: inlined into downstream models).",
        "deps": ["int_mfp_contract_coverage"],
        "sql": """select
    contract_id,
    coverage_id,
    risk_code,
    sum_insured_chf,
    base_rate,
    region_factor,
    round(sum_insured_chf / 1000 * base_rate * region_factor, 2) as technical_premium_chf,
    annual_premium_chf
from {{ ref('int_mfp_contract_coverage') }}""",
        "columns": [
            ("contract_id", "STRING", "Technical contract key."),
            ("coverage_id", "STRING", "Technical coverage key."),
            ("risk_code", "STRING", "Covered risk."),
            ("sum_insured_chf", "NUMERIC", "Sum insured in CHF."),
            ("base_rate", "NUMERIC", "Base rate per 1000 CHF sum insured."),
            ("region_factor", "NUMERIC", "Regional loading factor."),
            ("technical_premium_chf", "NUMERIC", "Calculated technical premium in CHF."),
            ("annual_premium_chf", "NUMERIC", "Gross annual premium in CHF."),
        ],
        "rows": None,
        "bytes": None,
    },
    # ----------------------------- bestand_mfp / 03_output -----------------------------
    {
        "name": "out_mfp_portfolio_daily",
        "pipeline": "bestand_mfp",
        "folder": "03_output",
        "materialized": "incremental",
        "execution_mode": "daily",
        "tags": ["mfp", "mart", "reporting"],
        "description": "Daily portfolio snapshot per product, canton and risk. Feeds the portfolio dashboard.",
        "deps": ["int_mfp_contract_coverage", "int_mfp_premium_calc"],
        "sql": """select
    current_date()                        as snapshot_date,
    cc.product_code,
    cc.canton,
    cc.risk_code,
    count(distinct cc.contract_id)        as contract_count,
    count(cc.coverage_id)                 as coverage_count,
    sum(cc.sum_insured_chf)               as sum_insured_chf,
    sum(pc.technical_premium_chf)         as technical_premium_chf,
    sum(cc.annual_premium_chf)            as written_premium_chf
from {{ ref('int_mfp_contract_coverage') }} cc
left join {{ ref('int_mfp_premium_calc') }} pc using (coverage_id)
where cc.contract_status = 'active'
group by 1, 2, 3, 4""",
        "columns": [
            ("snapshot_date", "DATE", "Snapshot day."),
            ("product_code", "STRING", "PnC product code."),
            ("canton", "STRING", "Swiss canton code."),
            ("risk_code", "STRING", "Covered risk."),
            ("contract_count", "INT64", "Distinct active contracts."),
            ("coverage_count", "INT64", "Number of coverage lines."),
            ("sum_insured_chf", "NUMERIC", "Total sum insured in CHF."),
            ("technical_premium_chf", "NUMERIC", "Total technical premium in CHF."),
            ("written_premium_chf", "NUMERIC", "Total written premium in CHF."),
        ],
        "rows": 284_112,
        "bytes": 62_914_560,
    },
    {
        "name": "out_mfp_premium_report",
        "pipeline": "bestand_mfp",
        "folder": "03_output",
        "materialized": "table",
        "execution_mode": "monthly",
        "tags": ["mfp", "mart", "finance"],
        "description": "Monthly premium reconciliation: technical vs. written premium per product.",
        "deps": ["int_mfp_premium_calc", "int_mfp_contracts"],
        "sql": """select
    date_trunc(current_date(), month)                       as reporting_month,
    c.product_code,
    count(distinct pc.contract_id)                          as contract_count,
    sum(pc.technical_premium_chf)                           as technical_premium_chf,
    sum(pc.annual_premium_chf)                              as annual_premium_chf,
    safe_divide(sum(pc.technical_premium_chf),
                sum(pc.annual_premium_chf))                 as premium_adequacy_ratio
from {{ ref('int_mfp_premium_calc') }} pc
join {{ ref('int_mfp_contracts') }} c using (contract_id)
group by 1, 2""",
        "columns": [
            ("reporting_month", "DATE", "First day of the reporting month."),
            ("product_code", "STRING", "PnC product code."),
            ("contract_count", "INT64", "Distinct contracts."),
            ("technical_premium_chf", "NUMERIC", "Technical premium in CHF."),
            ("annual_premium_chf", "NUMERIC", "Written premium in CHF."),
            ("premium_adequacy_ratio", "FLOAT64", "Technical / written premium."),
        ],
        "rows": 1_284,
        "bytes": 1_048_576,
    },
    {
        "name": "out_mfp_customer_360",
        "pipeline": "bestand_mfp",
        "folder": "03_output",
        "materialized": "view",
        "execution_mode": "daily",
        "tags": ["mfp", "mart", "crm"],
        "description": "One row per partner with portfolio aggregates for the CRM front-end.",
        "deps": ["int_mfp_contracts", "src_mfp_partners"],
        "sql": """select
    p.partner_id,
    p.partner_type,
    p.age_years,
    p.canton,
    p.language_code,
    count(c.contract_id)                                as contract_count,
    sum(c.annual_premium_chf)                           as total_premium_chf,
    min(c.valid_from)                                   as customer_since,
    array_agg(distinct c.product_code ignore nulls)     as product_codes
from {{ ref('src_mfp_partners') }} p
left join {{ ref('int_mfp_contracts') }} c using (partner_id)
group by 1, 2, 3, 4, 5""",
        "columns": [
            ("partner_id", "STRING", "Technical partner key."),
            ("partner_type", "STRING", "person | company."),
            ("age_years", "INT64", "Age of the partner."),
            ("canton", "STRING", "Swiss canton code."),
            ("language_code", "STRING", "Correspondence language."),
            ("contract_count", "INT64", "Number of contracts."),
            ("total_premium_chf", "NUMERIC", "Total annual premium in CHF."),
            ("customer_since", "DATE", "Earliest contract start."),
            ("product_codes", "ARRAY<STRING>", "Distinct product codes held."),
        ],
        "rows": 2_104_551,
        "bytes": 0,
    },
    {
        "name": "out_mfp_contracts",
        "pipeline": "bestand_mfp",
        "folder": "03_output",
        "materialized": "table",
        "execution_mode": "daily",
        "tags": ["mfp", "mart", "public"],
        "description": "Public contract dimension: the interface other pipelines read contract attributes from.",
        "deps": ["int_mfp_contracts"],
        "sql": """select
    contract_id,
    partner_id,
    product_code,
    canton,
    contract_status,
    annual_premium_chf,
    valid_from,
    valid_to
from {{ ref('int_mfp_contracts') }}""",
        "columns": [
            ("contract_id", "STRING", "Technical contract key."),
            ("partner_id", "STRING", "Policy holder reference."),
            ("product_code", "STRING", "PnC product code."),
            ("canton", "STRING", "Swiss canton code."),
            ("contract_status", "STRING", "active | cancelled | suspended."),
            ("annual_premium_chf", "NUMERIC", "Written annual premium in CHF."),
            ("valid_from", "DATE", "Start of the contract version."),
            ("valid_to", "DATE", "End of the contract version."),
        ],
        "rows": 4_812_004,
        "bytes": 734_003_200,
    },
    # --------------------------- schaden_claims / 01_source ---------------------------
    {
        "name": "src_claims_cases",
        "pipeline": "schaden_claims",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "hourly",
        "tags": ["claims", "staging"],
        "description": "Cleaned claim cases with harmonised status and reporting delay.",
        "deps": ["source:raw_claims.claims"],
        "sql": """select
    claim_id,
    contract_id,
    risk_code,
    loss_date,
    report_date,
    date_diff(report_date, loss_date, day)  as reporting_delay_days,
    lower(claim_status)                     as claim_status,
    reserve_amount                          as reserve_chf,
    load_ts                                 as _loaded_at
from {{ source('raw_claims', 'claims') }}
where loss_date is not null""",
        "columns": [
            ("claim_id", "STRING", "Technical claim key."),
            ("contract_id", "STRING", "Contract the claim was reported on."),
            ("risk_code", "STRING", "Affected risk."),
            ("loss_date", "DATE", "Date of loss."),
            ("report_date", "DATE", "Date the claim was reported."),
            ("reporting_delay_days", "INT64", "Days between loss and report."),
            ("claim_status", "STRING", "open | closed | reopened."),
            ("reserve_chf", "NUMERIC", "Case reserve in CHF."),
            ("_loaded_at", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 1_284_332,
        "bytes": 0,
    },
    {
        "name": "src_claims_payments",
        "pipeline": "schaden_claims",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "hourly",
        "tags": ["claims", "staging"],
        "description": "Cleaned claim payments with signed amounts per payment type.",
        "deps": ["source:raw_claims.payments"],
        "sql": """select
    payment_id,
    claim_id,
    payment_date,
    upper(payment_type)                                        as payment_type,
    case when upper(payment_type) = 'RECOVERY'
         then -abs(amount) else abs(amount) end                as amount_chf,
    load_ts                                                    as _loaded_at
from {{ source('raw_claims', 'payments') }}""",
        "columns": [
            ("payment_id", "STRING", "Technical payment key."),
            ("claim_id", "STRING", "Parent claim."),
            ("payment_date", "DATE", "Value date of the payment."),
            ("payment_type", "STRING", "INDEMNITY | EXPENSE | RECOVERY."),
            ("amount_chf", "NUMERIC", "Signed amount in CHF."),
            ("_loaded_at", "TIMESTAMP", "Technical load timestamp."),
        ],
        "rows": 3_942_118,
        "bytes": 0,
    },
    # convention: other pipelines are only read through their outputs, via a src model.
    # A `deps` entry naming another pipeline's model becomes a dbt source of this project.
    {
        "name": "src_claims_mfp_contracts",
        "pipeline": "schaden_claims",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "hourly",
        "tags": ["claims", "staging", "cross-pipeline"],
        "description": "Contract attributes imported from the portfolio pipeline (out_mfp_contracts).",
        "deps": ["out_mfp_contracts"],
        "sql": """select
    contract_id,
    partner_id,
    product_code,
    canton,
    annual_premium_chf
from {{ ref('out_mfp_contracts') }}
where contract_status = 'active'""",
        "columns": [
            ("contract_id", "STRING", "Technical contract key."),
            ("partner_id", "STRING", "Policy holder reference."),
            ("product_code", "STRING", "PnC product code."),
            ("canton", "STRING", "Swiss canton code."),
            ("annual_premium_chf", "NUMERIC", "Written annual premium in CHF."),
        ],
        "rows": 4_102_877,
        "bytes": 0,
    },
    {
        "name": "src_claims_mfp_portfolio",
        "pipeline": "schaden_claims",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "daily",
        "tags": ["claims", "staging", "cross-pipeline"],
        "description": "Today's portfolio snapshot imported from the portfolio pipeline (out_mfp_portfolio_daily).",
        "deps": ["out_mfp_portfolio_daily"],
        "sql": """select
    product_code,
    canton,
    risk_code,
    written_premium_chf
from {{ ref('out_mfp_portfolio_daily') }}
where snapshot_date = current_date()""",
        "columns": [
            ("product_code", "STRING", "PnC product code."),
            ("canton", "STRING", "Swiss canton code."),
            ("risk_code", "STRING", "Covered risk."),
            ("written_premium_chf", "NUMERIC", "Written premium in CHF."),
        ],
        "rows": 2_281,
        "bytes": 0,
    },
    {
        "name": "src_claims_mfp_premium",
        "pipeline": "schaden_claims",
        "folder": "01_source",
        "materialized": "view",
        "execution_mode": "monthly",
        "tags": ["claims", "staging", "finance", "cross-pipeline"],
        "description": "Premium reconciliation imported from the portfolio pipeline (out_mfp_premium_report).",
        "deps": ["out_mfp_premium_report"],
        "sql": """select
    product_code,
    technical_premium_chf,
    annual_premium_chf,
    premium_adequacy_ratio
from {{ ref('out_mfp_premium_report') }}
where reporting_month = date_trunc(current_date(), month)""",
        "columns": [
            ("product_code", "STRING", "PnC product code."),
            ("technical_premium_chf", "NUMERIC", "Technical premium in CHF."),
            ("annual_premium_chf", "NUMERIC", "Written premium in CHF."),
            ("premium_adequacy_ratio", "FLOAT64", "Technical / written premium."),
        ],
        "rows": 24,
        "bytes": 0,
    },
    # ------------------------ schaden_claims / 02_intermediate ------------------------
    {
        "name": "int_claims_cases",
        "pipeline": "schaden_claims",
        "folder": "02_intermediate",
        "materialized": "table",
        "execution_mode": "hourly",
        "tags": ["claims", "core", "cross-pipeline"],
        "description": "Claim cases enriched with contract attributes from the portfolio pipeline.",
        "deps": ["src_claims_cases", "src_claims_mfp_contracts"],
        "sql": """select
    cl.claim_id,
    cl.contract_id,
    cl.risk_code,
    cl.loss_date,
    cl.report_date,
    cl.reporting_delay_days,
    cl.claim_status,
    cl.reserve_chf,
    c.product_code,
    c.canton,
    c.partner_id,
    c.annual_premium_chf
from {{ ref('src_claims_cases') }} cl
left join {{ ref('src_claims_mfp_contracts') }} c using (contract_id)""",
        "columns": [
            ("claim_id", "STRING", "Technical claim key."),
            ("contract_id", "STRING", "Contract the claim was reported on."),
            ("risk_code", "STRING", "Affected risk."),
            ("loss_date", "DATE", "Date of loss."),
            ("report_date", "DATE", "Date the claim was reported."),
            ("reporting_delay_days", "INT64", "Days between loss and report."),
            ("claim_status", "STRING", "open | closed | reopened."),
            ("reserve_chf", "NUMERIC", "Case reserve in CHF."),
            ("product_code", "STRING", "PnC product code of the contract."),
            ("canton", "STRING", "Swiss canton code."),
            ("partner_id", "STRING", "Policy holder reference."),
            ("annual_premium_chf", "NUMERIC", "Written premium of the contract."),
        ],
        "rows": 1_284_332,
        "bytes": 419_430_400,
    },
    {
        "name": "int_claims_payments",
        "pipeline": "schaden_claims",
        "folder": "02_intermediate",
        "materialized": "incremental",
        "execution_mode": "hourly",
        "tags": ["claims", "core"],
        "description": "Payments aggregated per claim and payment type, incrementally loaded.",
        "deps": ["src_claims_payments"],
        "sql": """select
    claim_id,
    payment_type,
    count(*)            as payment_count,
    sum(amount_chf)     as paid_chf,
    max(payment_date)   as last_payment_date
from {{ ref('src_claims_payments') }}
{% if is_incremental() %}
where payment_date >= date_sub(current_date(), interval 7 day)
{% endif %}
group by 1, 2""",
        "columns": [
            ("claim_id", "STRING", "Parent claim."),
            ("payment_type", "STRING", "INDEMNITY | EXPENSE | RECOVERY."),
            ("payment_count", "INT64", "Number of payments."),
            ("paid_chf", "NUMERIC", "Signed paid amount in CHF."),
            ("last_payment_date", "DATE", "Most recent payment."),
        ],
        "rows": 2_841_993,
        "bytes": 603_979_776,
    },
    {
        "name": "int_claims_loss_ratio",
        "pipeline": "schaden_claims",
        "folder": "02_intermediate",
        "materialized": "table",
        "execution_mode": "daily",
        "tags": ["claims", "core", "cross-pipeline"],
        "description": "Loss ratio per product and canton, combining claims with the portfolio snapshot.",
        "deps": ["int_claims_cases", "int_claims_payments", "src_claims_mfp_portfolio"],
        "sql": """with claims as (
    select
        cs.product_code,
        cs.canton,
        cs.risk_code,
        count(distinct cs.claim_id)                as claim_count,
        sum(cs.reserve_chf)                        as reserve_chf,
        sum(coalesce(pm.paid_chf, 0))              as paid_chf
    from {{ ref('int_claims_cases') }} cs
    left join {{ ref('int_claims_payments') }} pm using (claim_id)
    group by 1, 2, 3
),

portfolio as (
    select product_code, canton, risk_code, sum(written_premium_chf) as written_premium_chf
    from {{ ref('src_claims_mfp_portfolio') }}
    group by 1, 2, 3
)

select
    c.product_code,
    c.canton,
    c.risk_code,
    c.claim_count,
    c.paid_chf,
    c.reserve_chf,
    p.written_premium_chf,
    safe_divide(c.paid_chf + c.reserve_chf, p.written_premium_chf) as loss_ratio
from claims c
left join portfolio p using (product_code, canton, risk_code)""",
        "columns": [
            ("product_code", "STRING", "PnC product code."),
            ("canton", "STRING", "Swiss canton code."),
            ("risk_code", "STRING", "Covered risk."),
            ("claim_count", "INT64", "Number of claims."),
            ("paid_chf", "NUMERIC", "Paid amount in CHF."),
            ("reserve_chf", "NUMERIC", "Outstanding reserves in CHF."),
            ("written_premium_chf", "NUMERIC", "Written premium in CHF."),
            ("loss_ratio", "FLOAT64", "(paid + reserve) / written premium."),
        ],
        "rows": 92_441,
        "bytes": 31_457_280,
    },
    # ---------------------------- schaden_claims / 03_output ----------------------------
    {
        "name": "out_claims_kpi_daily",
        "pipeline": "schaden_claims",
        "folder": "03_output",
        "materialized": "incremental",
        "execution_mode": "daily",
        "tags": ["claims", "mart", "reporting"],
        "description": "Daily claims KPI table for the management dashboard.",
        "deps": ["int_claims_loss_ratio"],
        "sql": """select
    current_date()                  as snapshot_date,
    product_code,
    canton,
    sum(claim_count)                as claim_count,
    sum(paid_chf)                   as paid_chf,
    sum(reserve_chf)                as reserve_chf,
    safe_divide(sum(paid_chf) + sum(reserve_chf),
                sum(written_premium_chf)) as loss_ratio
from {{ ref('int_claims_loss_ratio') }}
group by 1, 2, 3""",
        "columns": [
            ("snapshot_date", "DATE", "Snapshot day."),
            ("product_code", "STRING", "PnC product code."),
            ("canton", "STRING", "Swiss canton code."),
            ("claim_count", "INT64", "Number of claims."),
            ("paid_chf", "NUMERIC", "Paid amount in CHF."),
            ("reserve_chf", "NUMERIC", "Outstanding reserves in CHF."),
            ("loss_ratio", "FLOAT64", "Loss ratio."),
        ],
        "rows": 48_204,
        "bytes": 10_485_760,
    },
    {
        "name": "out_claims_reserve_report",
        "pipeline": "schaden_claims",
        "folder": "03_output",
        "materialized": "table",
        "execution_mode": "monthly",
        "tags": ["claims", "mart", "actuarial"],
        "description": "Reserve development per loss year for the actuarial department.",
        "deps": ["int_claims_cases", "int_claims_payments"],
        "sql": """select
    extract(year from cs.loss_date)      as loss_year,
    cs.product_code,
    cs.claim_status,
    count(distinct cs.claim_id)          as claim_count,
    sum(cs.reserve_chf)                  as reserve_chf,
    sum(coalesce(pm.paid_chf, 0))        as paid_chf,
    avg(cs.reporting_delay_days)         as avg_reporting_delay_days
from {{ ref('int_claims_cases') }} cs
left join {{ ref('int_claims_payments') }} pm using (claim_id)
group by 1, 2, 3""",
        "columns": [
            ("loss_year", "INT64", "Year of loss."),
            ("product_code", "STRING", "PnC product code."),
            ("claim_status", "STRING", "open | closed | reopened."),
            ("claim_count", "INT64", "Number of claims."),
            ("reserve_chf", "NUMERIC", "Outstanding reserves in CHF."),
            ("paid_chf", "NUMERIC", "Paid amount in CHF."),
            ("avg_reporting_delay_days", "FLOAT64", "Average reporting delay."),
        ],
        "rows": 2_104,
        "bytes": 2_097_152,
    },
    {
        "name": "out_pnc_combined_ratio",
        "pipeline": "schaden_claims",
        "folder": "03_output",
        "materialized": "table",
        "execution_mode": "monthly",
        "tags": ["claims", "mfp", "mart", "finance", "cross-pipeline"],
        "description": "Combined ratio per product: joins the claims loss ratio with the premium report.",
        "deps": ["int_claims_loss_ratio", "src_claims_mfp_premium"],
        "sql": """with loss as (
    select product_code,
           sum(paid_chf + reserve_chf) as incurred_chf,
           sum(written_premium_chf)    as written_premium_chf
    from {{ ref('int_claims_loss_ratio') }}
    group by 1
),

premium as (
    select product_code, technical_premium_chf, annual_premium_chf, premium_adequacy_ratio
    from {{ ref('src_claims_mfp_premium') }}
)

select
    l.product_code,
    l.incurred_chf,
    l.written_premium_chf,
    p.technical_premium_chf,
    p.premium_adequacy_ratio,
    safe_divide(l.incurred_chf, l.written_premium_chf)              as loss_ratio,
    safe_divide(l.incurred_chf * 0.28, l.written_premium_chf)       as expense_ratio,
    safe_divide(l.incurred_chf * 1.28, l.written_premium_chf)       as combined_ratio
from loss l
left join premium p using (product_code)""",
        "columns": [
            ("product_code", "STRING", "PnC product code."),
            ("incurred_chf", "NUMERIC", "Incurred claims in CHF."),
            ("written_premium_chf", "NUMERIC", "Written premium in CHF."),
            ("technical_premium_chf", "NUMERIC", "Technical premium in CHF."),
            ("premium_adequacy_ratio", "FLOAT64", "Technical / written premium."),
            ("loss_ratio", "FLOAT64", "Incurred / written premium."),
            ("expense_ratio", "FLOAT64", "Expenses / written premium."),
            ("combined_ratio", "FLOAT64", "Loss ratio + expense ratio."),
        ],
        "rows": 24,
        "bytes": 131_072,
    },
]

PIPELINES = ["bestand_mfp", "schaden_claims"]  # upstream first
SCHEMA_BY_FOLDER = {"01_source": "source", "02_intermediate": "intermediate", "03_output": "output"}
BQ_TYPE_BY_MATERIALIZATION = {"view": "VIEW", "table": "BASE TABLE", "incremental": "BASE TABLE"}


# dbt groups (domains) -> horizontal rows in the stage-lanes layout. Sources have no group in
# dbt; the loader places them in the group of their consumers.
GROUP_BY_MODEL: dict[str, str] = {
    "src_mfp_partners": "partner",
    "out_mfp_customer_360": "partner",
    "out_mfp_contracts": "contract",
    "src_claims_mfp_contracts": "claims",
    "src_claims_mfp_portfolio": "claims",
    "src_claims_mfp_premium": "finance",
    "src_mfp_contracts": "contract",
    "src_mfp_coverages": "contract",
    "int_mfp_contracts": "contract",
    "int_mfp_coverages": "contract",
    "int_mfp_contract_coverage": "contract",
    "out_mfp_portfolio_daily": "contract",
    "src_mfp_tariffs": "premium",
    "int_mfp_premium_calc": "premium",
    "out_mfp_premium_report": "premium",
    "src_claims_cases": "claims",
    "src_claims_payments": "claims",
    "int_claims_cases": "claims",
    "int_claims_payments": "claims",
    "int_claims_loss_ratio": "claims",
    "out_claims_kpi_daily": "claims",
    "out_claims_reserve_report": "claims",
    "out_pnc_combined_ratio": "finance",
}
GROUP_OWNERS: dict[str, str] = {
    "partner": "Partner Data Team",
    "contract": "Portfolio Team",
    "premium": "Pricing Team",
    "claims": "Claims Analytics",
    "finance": "Finance Controlling",
}


def source_id(project: str, source_name: str, table: str) -> str:
    return f"source.{project}.{source_name}.{table}"


def model_id(project: str, name: str) -> str:
    return f"model.{project}.{name}"


def schema_for(pipeline: str, folder: str) -> str:
    prefix = "mfp" if pipeline.startswith("bestand_mfp") else "claims"
    return f"{prefix}_{SCHEMA_BY_FOLDER[folder]}"


def compile_sql(sql: str, dep_lookup: dict[str, tuple[str, str]]) -> str:
    """Very small Jinja stand-in: replace ref()/source() with fully qualified names and
    drop incremental blocks, mirroring what `dbt compile` produces."""
    out = sql
    for token, (database, fqn) in dep_lookup.items():
        out = out.replace(token, f"`{database}`.{fqn}")
    # strip jinja control blocks (compiled code for a full refresh)
    while "{% if is_incremental() %}" in out:
        start = out.index("{% if is_incremental() %}")
        end = out.index("{% endif %}") + len("{% endif %}")
        out = out[:start] + out[end:]
    return "\n".join(line for line in out.splitlines() if line.strip() != "") + "\n"


def _catalog_entry(uid: str, kind: str, database: str, schema: str, name: str, description: str,
                   columns: list[tuple[str, str, str]], rows: int, size: int) -> dict[str, Any]:
    return {
        "unique_id": uid,
        "metadata": {"type": kind, "database": database, "schema": schema, "name": name,
                     "comment": description, "owner": None},
        "columns": {
            col: {"type": _type, "index": i + 1, "name": col, "comment": desc}
            for i, (col, _type, desc) in enumerate(columns)
        },
        "stats": {
            "num_rows": {"id": "num_rows", "label": "# Rows", "value": float(rows or 0),
                         "include": True, "description": "Approximate count of rows."},
            "num_bytes": {"id": "num_bytes", "label": "Approximate Size", "value": float(size or 0),
                          "include": True, "description": "Approximate size of table as reported by BigQuery."},
        },
    }


def _source_node(project: str, uid: str, *, source_name: str, table: str, database: str,
                 schema: str, description: str, columns: list[tuple[str, str, str]],
                 tags: list[str]) -> dict[str, Any]:
    return {
        "unique_id": uid,
        "resource_type": "source",
        "package_name": project,
        "name": table,
        "source_name": source_name,
        "identifier": table,
        "database": database,
        "schema": schema,
        "description": description,
        "original_file_path": "models/01_source/_sources.yml",
        "path": "01_source/_sources.yml",
        "tags": tags,
        "meta": {"owner": "data-platform"},
        "source_meta": {},
        "loader": "airflow",
        "columns": {col: {"name": col, "description": desc, "meta": {}, "tags": []}
                    for col, _type, desc in columns},
    }


def build_project(pipeline: str, tag: str = "") -> tuple[dict[str, Any], dict[str, Any]]:
    """Artifacts of ONE pipeline = one dbt project (`project_name` is always DBT_PROJECT).

    Layout: models/01_source, models/02_intermediate, models/03_output. Outputs of other
    pipelines are imported as dbt sources (source_name = the upstream pipeline), so this
    manifest never references a node of another project, exactly like separate real projects.
    """
    project = DBT_PROJECT
    by_name = {m["name"]: m for m in MODELS}
    manifest_nodes: dict[str, Any] = {}
    manifest_sources: dict[str, Any] = {}
    catalog_nodes: dict[str, Any] = {}
    catalog_sources: dict[str, Any] = {}
    parent_map: dict[str, list[str]] = {}
    child_map: dict[str, list[str]] = {}

    # ------------------------------------------------------------- raw sources
    for src in (s for s in SOURCES if s["pipeline"] == pipeline):
        uid = source_id(project, src["source_name"], src["name"])
        manifest_sources[uid] = _source_node(
            project, uid, source_name=src["source_name"], table=src["name"], database=RAW_DATABASE,
            schema=src["source_name"], description=src["description"], columns=src["columns"],
            tags=["source", src["source_name"]],
        )
        catalog_sources[uid] = _catalog_entry(uid, "BASE TABLE", RAW_DATABASE, src["source_name"],
                                              src["name"], src["description"], src["columns"],
                                              src["rows"], src["bytes"])
        parent_map[uid] = []

    # ------------------------------------------------------------------ models
    for model in (m for m in MODELS if m["pipeline"] == pipeline):
        name = f"{model['name']}{tag}"
        uid = model_id(project, name)
        schema = schema_for(pipeline, model["folder"])
        # sub-folder = the model's dbt group (as in real projects: models/01_source/claims/x.sql),
        # so the lineage explorer draws one box per group inside each stage
        sub = GROUP_BY_MODEL.get(model["name"])
        folder_path = f"{model['folder']}/{sub}/{name}.sql" if sub else f"{model['folder']}/{name}.sql"
        sql = model["sql"]

        dep_ids: list[str] = []
        dep_lookup: dict[str, tuple[str, str]] = {}
        refs: list[str] = []
        sources: list[list[str]] = []
        for dep in model["deps"]:
            if dep.startswith("source:"):
                source_name, table = dep.split(":", 1)[1].split(".")
                dep_uid = source_id(project, source_name, table)
                dep_lookup[f"{{{{ source('{source_name}', '{table}') }}}}"] = (
                    RAW_DATABASE, f"{source_name}.{table}")
                sources.append([source_name, table])
            elif by_name[dep]["pipeline"] != pipeline:
                # another pipeline's output: declared as a source of THIS project
                upstream = by_name[dep]
                source_name, table = f"{upstream['pipeline']}{tag}", f"{dep}{tag}"
                up_schema = schema_for(upstream["pipeline"], upstream["folder"])
                dep_uid = source_id(project, source_name, table)
                token = f"{{{{ source('{source_name}', '{table}') }}}}"
                sql = sql.replace(f"{{{{ ref('{dep}') }}}}", token)
                dep_lookup[token] = (DATABASE, f"{up_schema}.{table}")
                sources.append([source_name, table])
                if dep_uid not in manifest_sources:
                    description = f"Output of pipeline {source_name}: {upstream['description']}"
                    manifest_sources[dep_uid] = _source_node(
                        project, dep_uid, source_name=source_name, table=table, database=DATABASE,
                        schema=up_schema, description=description, columns=upstream["columns"],
                        tags=["source", "cross-pipeline"],
                    )
                    catalog_sources[dep_uid] = _catalog_entry(
                        dep_uid, BQ_TYPE_BY_MATERIALIZATION[upstream["materialized"]], DATABASE,
                        up_schema, table, description, upstream["columns"], upstream["rows"],
                        upstream["bytes"])
                    parent_map[dep_uid] = []
            else:
                dep_name = f"{dep}{tag}"
                dep_uid = model_id(project, dep_name)
                dep_lookup[f"{{{{ ref('{dep}') }}}}"] = (
                    DATABASE, f"{schema_for(pipeline, by_name[dep]['folder'])}.{dep_name}")
                refs.append(dep)
            dep_ids.append(dep_uid)
            child_map.setdefault(dep_uid, []).append(uid)

        raw_code = (
            "{{ config(materialized='" + model["materialized"] + "'"
            + (", unique_key='" + model["columns"][0][0] + "'" if model["materialized"] == "incremental" else "")
            + ") }}\n\n" + sql
        )
        group = GROUP_BY_MODEL.get(model["name"])
        manifest_nodes[uid] = {
            "unique_id": uid,
            "resource_type": "model",
            "package_name": project,
            "name": name,
            "alias": name,
            "database": DATABASE,
            "schema": schema,
            "path": folder_path,
            "original_file_path": f"models/{folder_path}",
            "description": model["description"],
            "tags": model["tags"],
            "group": group,
            "config": {
                "enabled": True,
                "group": group,
                "materialized": model["materialized"],
                "schema": SCHEMA_BY_FOLDER[model["folder"]],
                "tags": model["tags"],
                "meta": {"execution_mode": model["execution_mode"], "owner": "pnc-analytics"},
            },
            "meta": {"execution_mode": model["execution_mode"]},
            "depends_on": {"macros": [], "nodes": dep_ids},
            "refs": [{"name": d, "package": None, "version": None} for d in refs],
            "sources": sources,
            "compiled": True,
            "raw_code": raw_code,
            "compiled_code": compile_sql(sql, dep_lookup),
            "columns": {col: {"name": col, "description": desc, "meta": {}, "tags": []}
                        for col, _type, desc in model["columns"]},
            "checksum": {"name": "sha256", "checksum": f"{abs(hash(uid)):064x}"[:64]},
        }
        parent_map[uid] = dep_ids

        if model["materialized"] != "ephemeral":
            catalog_nodes[uid] = _catalog_entry(
                uid, BQ_TYPE_BY_MATERIALIZATION[model["materialized"]], DATABASE, schema, name,
                model["description"], model["columns"], model["rows"], model["bytes"])

    for uid in list(manifest_nodes) + list(manifest_sources):
        child_map.setdefault(uid, [])

    metadata = {
        "dbt_schema_version": "https://schemas.getdbt.com/dbt/manifest/v12.json",
        "dbt_version": DBT_VERSION,
        "generated_at": GENERATED_AT,
        "invocation_id": "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
        "project_name": project,
        "project_id": f"{pipeline}{tag}".replace("_", "")[:32].ljust(32, "0"),
        "adapter_type": "bigquery",
        "env": {},
    }
    used_groups = {n["group"] for n in manifest_nodes.values() if n["group"]}
    manifest = {
        "metadata": metadata,
        "nodes": manifest_nodes,
        "sources": manifest_sources,
        "macros": {},
        "exposures": {},
        "metrics": {},
        "groups": {
            f"group.{project}.{g}": {
                "name": g,
                "resource_type": "group",
                "package_name": project,
                "path": "groups.yml",
                "original_file_path": "models/groups.yml",
                "unique_id": f"group.{project}.{g}",
                "owner": {"name": owner, "email": None},
            }
            for g, owner in GROUP_OWNERS.items()
            if g in used_groups
        },
        "selectors": {},
        "docs": {},
        "parent_map": parent_map,
        "child_map": child_map,
        "disabled": {},
    }
    catalog = {
        "metadata": {**metadata, "dbt_schema_version": "https://schemas.getdbt.com/dbt/catalog/v1.json"},
        "nodes": catalog_nodes,
        "sources": catalog_sources,
        "errors": None,
        "_compile_results": None,
    }
    return manifest, catalog


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scale", type=int, default=1,
                        help="clone the pipelines N times for performance testing (default 1)")
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    projects: list[str] = []
    for suffix in range(max(1, args.scale)):
        tag = "" if suffix == 0 else f"_c{suffix}"
        for pipeline in PIPELINES:
            manifest, catalog = build_project(pipeline, tag)
            project = f"{pipeline}{tag}"  # pipeline name: folder + pipelines.yaml entry
            target = out_dir / project
            target.mkdir(exist_ok=True)
            (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            (target / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")
            projects.append(project)
            n_edges = sum(len(v) for v in manifest["parent_map"].values())
            print(f"wrote {target}/  ({len(manifest['nodes'])} models, "
                  f"{len(manifest['sources'])} sources, {n_edges} edges)")

    config = "# Generated by generate_fixtures.py. One entry per pipeline (= dbt project).\npipelines:\n"
    config += "".join(f"  - name: {p}\n    dir: {p}\n" for p in projects)
    (out_dir / "pipelines.yaml").write_text(config)
    print(f"wrote {out_dir}/pipelines.yaml  ({len(projects)} pipelines)")
    print(f"generated_at (fixture): {GENERATED_AT} · generator run: {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
