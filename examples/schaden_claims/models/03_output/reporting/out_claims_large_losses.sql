select
    claim_id,
    contract_id,
    partner_id,
    product_code,
    canton,
    risk_code,
    loss_date,
    claim_status,
    reserve_chf
from {{ ref('int_claims_cases') }}
where is_large_loss
