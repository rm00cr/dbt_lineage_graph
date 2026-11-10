select
    contract_id,
    partner_id,
    product_code,
    canton,
    annual_premium_chf
from {{ source('mfp_output', 'out_mfp_contracts') }}
