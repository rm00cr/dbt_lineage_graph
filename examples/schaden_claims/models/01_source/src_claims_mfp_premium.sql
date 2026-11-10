select
    product_code,
    sum(technical_premium_chf)                                      as technical_premium_chf,
    sum(annual_premium_chf)                                         as annual_premium_chf,
    sum(annual_premium_chf) / nullif(sum(technical_premium_chf), 0) as premium_adequacy_ratio
from {{ source('mfp_output', 'out_mfp_premium_report') }}
group by 1
