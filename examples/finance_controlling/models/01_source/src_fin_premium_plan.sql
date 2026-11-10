{{ config(enabled=var('include_plan')) }}

select
    plan_month,
    product_code,
    planned_premium_chf,
    planned_loss_ratio,
    planned_expense_ratio
from {{ source('raw_finance', 'premium_plan') }}
