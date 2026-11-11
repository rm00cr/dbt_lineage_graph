with expenses as (
    select
        reporting_month,
        product_code,
        sum(expenses_chf)   as expenses_chf
    from {{ ref('int_fin_expenses_by_product') }}
    group by 1, 2
)

select
    premium.reporting_month,
    premium.product_code,
    premium.earned_premium_chf,
    premium.technical_premium_chf,
    coalesce(claims.paid_chf, 0) + coalesce(claims.reserve_chf, 0)    as incurred_chf,
    coalesce(expenses.expenses_chf, 0)                                 as expenses_chf,
    premium.earned_premium_chf
        - coalesce(claims.paid_chf, 0) - coalesce(claims.reserve_chf, 0)
        - coalesce(expenses.expenses_chf, 0)                           as underwriting_result_chf
from {{ ref('stg_fin_mfp_premium') }} as premium
left join {{ ref('stg_fin_claims_kpi') }} as claims
    on premium.reporting_month = claims.reporting_month
    and premium.product_code = claims.product_code
left join expenses
    on premium.reporting_month = expenses.reporting_month
    and premium.product_code = expenses.product_code
