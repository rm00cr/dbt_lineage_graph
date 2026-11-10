select
    payment_id,
    claim_id,
    payment_date,
    lower(payment_type)   as payment_type,
    amount                as amount_chf,
    load_ts               as _loaded_at
from {{ source('raw_claims', 'payments') }}
where amount <> 0
