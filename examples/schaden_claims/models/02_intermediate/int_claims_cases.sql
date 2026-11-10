select
    cases.claim_id,
    cases.contract_id,
    cases.risk_code,
    cases.loss_date,
    cases.report_date,
    cases.reporting_delay_days,
    cases.claim_status,
    cases.reserve_chf,
    cases.reserve_chf > {{ var('large_loss_threshold') }}   as is_large_loss,
    contracts.product_code,
    contracts.canton,
    contracts.partner_id,
    contracts.annual_premium_chf
from {{ ref('src_claims_cases') }} as cases
left join {{ ref('src_claims_mfp_contracts') }} as contracts
    on cases.contract_id = contracts.contract_id
