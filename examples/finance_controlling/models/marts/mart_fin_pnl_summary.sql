select
    pnl.reporting_month,
    pnl.product_code,
    pnl.earned_premium_chf,
    pnl.incurred_chf,
    pnl.expenses_chf,
    pnl.underwriting_result_chf,
    (pnl.incurred_chf + pnl.expenses_chf) / nullif(pnl.earned_premium_chf, 0)   as combined_ratio,
    ratios.combined_ratio                                                       as claims_combined_ratio
from {{ ref('int_fin_pnl') }} as pnl
left join {{ ref('stg_fin_combined_ratio') }} as ratios
    on pnl.product_code = ratios.product_code
