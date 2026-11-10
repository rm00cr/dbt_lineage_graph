-- expense ratio is a flat planning assumption until finance_controlling delivers actuals
with claims as (
    select
        product_code,
        sum(paid_chf + reserve_chf)   as incurred_chf,
        sum(written_premium_chf)      as written_premium_chf
    from {{ ref('int_claims_loss_ratio') }}
    group by 1
)

select
    claims.product_code,
    claims.incurred_chf,
    claims.written_premium_chf,
    premium.technical_premium_chf,
    premium.premium_adequacy_ratio,
    claims.incurred_chf / nullif(claims.written_premium_chf, 0)          as loss_ratio,
    0.28                                                                 as expense_ratio,
    claims.incurred_chf / nullif(claims.written_premium_chf, 0) + 0.28   as combined_ratio
from claims
left join {{ ref('src_claims_mfp_premium') }} as premium
    on claims.product_code = premium.product_code
