{#- plan vs. actual only: plan against the closed month-end portfolio and the P&L -#}
{{ config(enabled=var('include_plan')) }}

select
    plan.plan_month                                                   as reporting_month,
    plan.product_code,
    plan.planned_premium_chf,
    portfolio.written_premium_chf / 12                                as actual_premium_chf,
    plan.planned_loss_ratio,
    pnl.incurred_chf / nullif(pnl.earned_premium_chf, 0)              as actual_loss_ratio,
    plan.planned_expense_ratio,
    pnl.expenses_chf / nullif(pnl.earned_premium_chf, 0)              as actual_expense_ratio,
    portfolio.contract_count
from {{ ref('stg_fin_premium_plan') }} as plan
left join {{ ref('stg_fin_mfp_portfolio_monthly') }} as portfolio
    on plan.plan_month = portfolio.reporting_month
    and plan.product_code = portfolio.product_code
left join {{ ref('int_fin_pnl') }} as pnl
    on plan.plan_month = pnl.reporting_month
    and plan.product_code = pnl.product_code
