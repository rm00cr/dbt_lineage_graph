-- dq check: every contract has at least one coverage. Returns the contracts without one.
select contracts.contract_id
from {{ ref('int_mfp_contracts') }} as contracts
left join {{ ref('int_mfp_coverages') }} as coverages
    on contracts.contract_id = coverages.contract_id
where coverages.coverage_id is null
