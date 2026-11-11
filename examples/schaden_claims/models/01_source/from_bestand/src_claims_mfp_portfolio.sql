-- latest portfolio snapshot only
select
    product_code,
    canton,
    risk_code,
    written_premium_chf
from {{ source('mfp_output', 'out_mfp_portfolio_daily') }}
where snapshot_date = (select max(snapshot_date) from {{ source('mfp_output', 'out_mfp_portfolio_daily') }})
