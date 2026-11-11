{{ config(materialized='incremental', unique_key=['snapshot_date', 'product_code', 'canton', 'risk_code']) }}

select
    current_date                          as snapshot_date,
    portfolio.product_code,
    portfolio.canton,
    portfolio.risk_code,
    count(distinct portfolio.contract_id) as contract_count,
    count(*)                              as coverage_count,
    sum(portfolio.sum_insured_chf)        as sum_insured_chf,
    sum(premium.technical_premium_chf)    as technical_premium_chf,
    sum(portfolio.annual_premium_chf)     as written_premium_chf
from {{ ref('int_mfp_contract_coverage') }} as portfolio
inner join {{ ref('int_mfp_premium_calc') }} as premium
    on portfolio.coverage_id = premium.coverage_id
group by 1, 2, 3, 4
