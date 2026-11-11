select
    coverage_id,
    contract_id,
    risk_code,
    sum_insured   as sum_insured_chf,
    deductible    as deductible_chf,
    tariff_code,
    valid_from,
    load_ts       as _loaded_at
from {{ source('raw_mfp', 'coverages') }}
where sum_insured > 0
