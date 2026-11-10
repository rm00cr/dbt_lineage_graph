{#- month-end close only: the closed portfolio per month, read by finance_controlling -#}
{{ config(enabled=var('monthly_mode')) }}

select
    reporting_month,
    product_code,
    canton,
    count(distinct contract_id)  as contract_count,
    sum(sum_insured_chf)         as sum_insured_chf,
    sum(technical_premium_chf)   as technical_premium_chf,
    sum(annual_premium_chf)      as written_premium_chf
from {{ ref('int_mfp_month_end_snapshot') }}
group by 1, 2, 3
