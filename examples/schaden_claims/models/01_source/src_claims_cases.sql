select
    claim_id,
    contract_id,
    risk_code,
    loss_date,
    report_date,
    {{ dbt.datediff('loss_date', 'report_date', 'day') }}    as reporting_delay_days,
    lower(claim_status)                                      as claim_status,
    reserve_amount                                           as reserve_chf,
    load_ts                                                  as _loaded_at
from {{ source('raw_claims', 'claims') }}
