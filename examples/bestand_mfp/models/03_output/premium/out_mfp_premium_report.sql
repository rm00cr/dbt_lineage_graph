{#- month-end close reports the frozen snapshot, otherwise the live premium calculation -#}
with premium as (
{% if var('monthly_mode') %}
    select
        reporting_month,
        contract_id,
        product_code,
        technical_premium_chf,
        annual_premium_chf
    from {{ ref('int_mfp_month_end_snapshot') }}
{% else %}
    select
        {{ dbt.date_trunc('month', 'current_date') }} as reporting_month,
        contract_id,
        product_code,
        technical_premium_chf,
        annual_premium_chf
    from {{ ref('int_mfp_premium_calc') }}
{% endif %}
)

select
    premium.reporting_month,
    premium.product_code,
    count(distinct premium.contract_id)                                             as contract_count,
    sum(premium.technical_premium_chf)                                              as technical_premium_chf,
    sum(premium.annual_premium_chf)                                                 as annual_premium_chf,
    sum(premium.annual_premium_chf) / nullif(sum(premium.technical_premium_chf), 0) as premium_adequacy_ratio
from premium
group by 1, 2
