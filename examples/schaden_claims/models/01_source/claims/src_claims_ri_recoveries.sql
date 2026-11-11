{{ config(enabled=var('include_reinsurance')) }}

select
    recovery_id,
    claim_id,
    treaty_id,
    recovery_date,
    recovered_amount   as recovered_chf,
    load_ts            as _loaded_at
from {{ source('raw_claims', 'ri_recoveries') }}
