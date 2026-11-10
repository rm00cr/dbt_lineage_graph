-- the tariff export re-delivers unchanged rows: keep the latest load per version
select
    tariff_code,
    risk_code,
    region_factor,
    base_rate,
    valid_from
from {{ source('raw_mfp', 'tariffs') }}
qualify row_number() over (partition by tariff_code, risk_code, valid_from order by load_ts desc) = 1
