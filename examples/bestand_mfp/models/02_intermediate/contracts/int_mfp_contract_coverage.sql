select
    contracts.contract_id,
    coverages.coverage_id,
    contracts.partner_id,
    contracts.product_code,
    coverages.risk_code,
    contracts.contract_status,
    contracts.canton,
    coverages.sum_insured_chf,
    coverages.deductible_chf,
    coverages.region_factor,
    coverages.base_rate,
    contracts.annual_premium_chf,
    coverages.valid_from
from {{ ref('int_mfp_contracts') }} as contracts
inner join {{ ref('int_mfp_coverages') }} as coverages
    on contracts.contract_id = coverages.contract_id
where contracts.contract_status = 'active'
