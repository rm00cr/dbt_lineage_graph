{{ config(enabled=not var('full_mode')) }}

select
    contract_id,
    partner_id,
    product_code,
    valid_from,
    nullif(valid_to, date '9999-12-31')          as valid_to,
    case status_code
        when 'A' then 'active'
        when 'C' then 'cancelled'
        when 'S' then 'suspended'
        else 'unknown'
    end                                          as contract_status,
    annual_premium                               as annual_premium_chf,
    change_type = 'D'                            as is_deleted,
    change_ts                                    as _loaded_at
from {{ source('raw_mfp', 'contract_changes') }}
where contract_id is not null
