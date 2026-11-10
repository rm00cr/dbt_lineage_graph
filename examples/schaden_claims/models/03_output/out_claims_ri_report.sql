{#- net of reinsurance only: what the treaties recovered, per product -#}
{{ config(enabled=var('include_reinsurance')) }}

select
    cases.product_code,
    count(distinct net.claim_id)    as claim_count,
    sum(net.gross_paid_chf)         as gross_paid_chf,
    sum(net.ri_recovered_chf)       as ri_recovered_chf,
    sum(net.net_paid_chf)           as net_paid_chf,
    sum(net.ri_recovered_chf) / nullif(sum(net.gross_paid_chf), 0)   as recovery_rate
from {{ ref('int_claims_net_payments') }} as net
inner join {{ ref('int_claims_cases') }} as cases
    on net.claim_id = cases.claim_id
group by 1
