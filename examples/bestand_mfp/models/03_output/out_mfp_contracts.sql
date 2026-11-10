select
    contract_id,
    partner_id,
    product_code,
    canton,
    contract_status,
    annual_premium_chf,
    valid_from,
    valid_to
from {{ ref('int_mfp_contracts') }}
