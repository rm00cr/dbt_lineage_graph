{#- net of reinsurance only: gross payments minus reinsurance recoveries per claim -#}
{{ config(enabled=var('include_reinsurance')) }}

with gross as (
    select
        claim_id,
        sum(paid_chf)   as gross_paid_chf
    from {{ ref('int_claims_payments') }}
    group by 1
),

recoveries as (
    select
        claim_id,
        sum(recovered_chf)   as recovered_chf
    from {{ ref('src_claims_ri_recoveries') }}
    group by 1
)

select
    gross.claim_id,
    gross.gross_paid_chf,
    coalesce(recoveries.recovered_chf, 0)                           as ri_recovered_chf,
    gross.gross_paid_chf - coalesce(recoveries.recovered_chf, 0)    as net_paid_chf
from gross
left join recoveries
    on gross.claim_id = recoveries.claim_id
