-- month view of the daily claims KPIs: the last snapshot of each month
select
    {{ dbt.date_trunc('month', 'snapshot_date') }}   as reporting_month,
    product_code,
    sum(paid_chf)                                     as paid_chf,
    sum(reserve_chf)                                  as reserve_chf
from {{ source('claims_output', 'out_claims_kpi_daily') }}
where snapshot_date in (
    select max(snapshot_date)
    from {{ source('claims_output', 'out_claims_kpi_daily') }}
    group by {{ dbt.date_trunc('month', 'snapshot_date') }}
)
group by 1, 2
