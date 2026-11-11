select
    partner_id,
    case partner_type
        when 'P' then 'person'
        when 'C' then 'company'
    end                                                          as partner_type,
    birth_date,
    {{ dbt.datediff('birth_date', 'current_date', 'year') }}     as age_years,
    postal_code,
    canton,
    lower(language_code)                                         as language_code,
    load_ts                                                      as _loaded_at
from {{ source('raw_mfp', 'partners') }}
