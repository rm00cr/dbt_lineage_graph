{{ config(materialized='incremental', unique_key=['claim_id', 'payment_type']) }}

select
    claim_id,
    payment_type,
    count(*)            as payment_count,
    sum(amount_chf)     as paid_chf,
    max(payment_date)   as last_payment_date,
    max(_loaded_at)     as _loaded_at
from {{ ref('src_claims_payments') }}
{% if is_incremental() %}
where claim_id in (
    select claim_id
    from {{ ref('src_claims_payments') }}
    where _loaded_at > (select max(_loaded_at) from {{ this }})
)
{% endif %}
group by 1, 2
