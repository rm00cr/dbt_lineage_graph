{{ config(enabled=var('include_plan')) }}

select
    reporting_month,
    product_code,
    sum(contract_count)        as contract_count,
    sum(written_premium_chf)   as written_premium_chf
from {{ source('mfp_output', 'out_mfp_portfolio_monthly') }}
group by 1, 2
