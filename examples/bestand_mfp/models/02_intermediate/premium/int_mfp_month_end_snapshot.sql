{#- month-end close only (monthly_mode): frozen portfolio state per reporting month -#}
{{ config(enabled=var('monthly_mode'), materialized='incremental', unique_key=['reporting_month', 'coverage_id']) }}

select
    {{ dbt.date_trunc('month', 'current_date') }}   as reporting_month,
    premium.contract_id,
    premium.coverage_id,
    premium.product_code,
    premium.risk_code,
    portfolio.canton,
    premium.sum_insured_chf,
    premium.technical_premium_chf,
    premium.annual_premium_chf
from {{ ref('int_mfp_premium_calc') }} as premium
inner join {{ ref('int_mfp_contract_coverage') }} as portfolio
    on premium.coverage_id = portfolio.coverage_id
