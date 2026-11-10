select
    expenses.reporting_month,
    expenses.product_code,
    expenses.expense_type,
    expenses.expenses_chf,
    premium.earned_premium_chf,
    expenses.expenses_chf / nullif(premium.earned_premium_chf, 0)   as expense_ratio
from {{ ref('int_fin_expenses_by_product') }} as expenses
left join {{ ref('stg_fin_mfp_premium') }} as premium
    on expenses.reporting_month = premium.reporting_month
    and expenses.product_code = premium.product_code
