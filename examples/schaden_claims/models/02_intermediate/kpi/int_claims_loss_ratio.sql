{#- gross: paid from the payment feed; net of reinsurance: paid after RI recoveries -#}
with paid as (
{% if var('include_reinsurance') %}
    select
        claim_id,
        net_paid_chf   as paid_chf
    from {{ ref('int_claims_net_payments') }}
{% else %}
    select
        claim_id,
        sum(paid_chf)  as paid_chf
    from {{ ref('int_claims_payments') }}
    group by 1
{% endif %}
),

claims as (
    select
        cases.product_code,
        cases.canton,
        cases.risk_code,
        count(*)                              as claim_count,
        sum(coalesce(paid.paid_chf, 0))       as paid_chf,
        sum(cases.reserve_chf)                as reserve_chf
    from {{ ref('int_claims_cases') }} as cases
    left join paid
        on cases.claim_id = paid.claim_id
    group by 1, 2, 3
)

select
    claims.product_code,
    claims.canton,
    claims.risk_code,
    claims.claim_count,
    claims.paid_chf,
    claims.reserve_chf,
    portfolio.written_premium_chf,
    (claims.paid_chf + claims.reserve_chf) / nullif(portfolio.written_premium_chf, 0)   as loss_ratio
from claims
left join {{ ref('src_claims_mfp_portfolio') }} as portfolio
    on claims.product_code = portfolio.product_code
    and claims.canton = portfolio.canton
    and claims.risk_code = portfolio.risk_code
