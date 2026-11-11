select
    product_code,
    loss_ratio,
    expense_ratio    as assumed_expense_ratio,
    combined_ratio
from {{ source('claims_output', 'out_pnc_combined_ratio') }}
