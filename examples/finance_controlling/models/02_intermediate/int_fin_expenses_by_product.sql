{#- direct expenses as booked; shared expenses (no product) allocated by var expense_alloc:
    premium = by share of earned premium, flat = equally over the products of the month -#}
with expenses as (
    select
        expenses.booking_month,
        expenses.product_code,
        expenses.expense_type,
        cost_centers.department,
        expenses.amount_chf
    from {{ ref('src_fin_expenses') }} as expenses
    inner join {{ ref('src_fin_cost_centers') }} as cost_centers
        on expenses.cost_center_id = cost_centers.cost_center_id
),

products as (
    select
        reporting_month,
        product_code,
{% if var('expense_alloc') == 'premium' %}
        earned_premium_chf / nullif(sum(earned_premium_chf) over (partition by reporting_month), 0)   as allocation_share
{% else %}
        1.0 / count(*) over (partition by reporting_month)                                             as allocation_share
{% endif %}
    from {{ ref('src_fin_mfp_premium') }}
),

direct_expenses as (
    select
        booking_month       as reporting_month,
        product_code,
        expense_type,
        sum(amount_chf)     as expenses_chf
    from expenses
    where product_code is not null
    group by 1, 2, 3
),

shared_expenses as (
    select
        products.reporting_month,
        products.product_code,
        expenses.expense_type,
        sum(expenses.amount_chf * products.allocation_share)   as expenses_chf
    from expenses
    inner join products
        on expenses.booking_month = products.reporting_month
    where expenses.product_code is null
    group by 1, 2, 3
),

all_expenses as (
    select reporting_month, product_code, expense_type, expenses_chf from direct_expenses
    union all
    select reporting_month, product_code, expense_type, expenses_chf from shared_expenses
)

select
    reporting_month,
    product_code,
    expense_type,
    sum(expenses_chf)   as expenses_chf
from all_expenses
group by 1, 2, 3
