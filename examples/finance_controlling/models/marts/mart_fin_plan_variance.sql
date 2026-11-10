{{ config(enabled=var('include_plan')) }}

select
    reporting_month,
    product_code,
    planned_premium_chf,
    actual_premium_chf,
    actual_premium_chf - planned_premium_chf                        as premium_variance_chf,
    actual_premium_chf / nullif(planned_premium_chf, 0) - 1         as premium_variance_pct,
    actual_loss_ratio - planned_loss_ratio                          as loss_ratio_variance,
    actual_expense_ratio - planned_expense_ratio                    as expense_ratio_variance
from {{ ref('int_fin_plan_vs_actual') }}
