with paid as (
    select
        claim_id,
        sum(paid_chf)   as paid_chf
    from {{ ref('int_claims_payments') }}
    group by 1
)

select
    extract(year from cases.loss_date)       as loss_year,
    cases.product_code,
    cases.claim_status,
    count(*)                                 as claim_count,
    sum(cases.reserve_chf)                   as reserve_chf,
    sum(coalesce(paid.paid_chf, 0))          as paid_chf,
    avg(cases.reporting_delay_days)          as avg_reporting_delay_days
from {{ ref('int_claims_cases') }} as cases
left join paid
    on cases.claim_id = paid.claim_id
group by 1, 2, 3
