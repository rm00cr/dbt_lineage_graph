{{ config(materialized='ephemeral') }}

select
    contract_id,
    coverage_id,
    product_code,
    risk_code,
    sum_insured_chf,
    base_rate,
    region_factor,
    round(sum_insured_chf / 1000 * base_rate * region_factor, 2)   as technical_premium_chf,
    annual_premium_chf
from {{ ref('int_mfp_contract_coverage') }}
