{{ config(materialized='incremental', unique_key='coverage_id') }}

with coverages as (
    select
        coverage_id,
        contract_id,
        risk_code,
        sum_insured_chf,
        deductible_chf,
        tariff_code,
        valid_from,
        _loaded_at
    from {{ ref('src_mfp_coverages') }}
    {% if is_incremental() %}
    where _loaded_at > (select max(_loaded_at) from {{ this }})
    {% endif %}
),

tariffs as (
    select
        tariff_code,
        risk_code,
        region_factor,
        base_rate,
        valid_from
    from {{ ref('src_mfp_tariffs') }}
)

select
    coverages.coverage_id,
    coverages.contract_id,
    coverages.risk_code,
    coverages.sum_insured_chf,
    coverages.deductible_chf,
    coverages.tariff_code,
    coverages.valid_from,
    tariffs.region_factor,
    tariffs.base_rate,
    coverages._loaded_at
from coverages
left join tariffs
    on coverages.tariff_code = tariffs.tariff_code
    and coverages.risk_code = tariffs.risk_code
    and coverages.valid_from >= tariffs.valid_from
qualify row_number() over (partition by coverages.coverage_id order by tariffs.valid_from desc) = 1
