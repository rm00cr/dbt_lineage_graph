select
    reporting_month,
    product_code,
    annual_premium_chf / 12     as earned_premium_chf,
    technical_premium_chf / 12  as technical_premium_chf
from {{ source('mfp_output', 'out_mfp_premium_report') }}
