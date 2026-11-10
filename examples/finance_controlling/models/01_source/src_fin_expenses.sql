select
    expense_id,
    cost_center_id,
    booking_date,
    {{ dbt.date_trunc('month', 'booking_date') }}   as booking_month,
    product_code,
    case expense_type
        when 'ACQ' then 'acquisition'
        when 'ADM' then 'administration'
        when 'CLM' then 'claims_handling'
        else 'other'
    end                                             as expense_type,
    amount                                          as amount_chf
from {{ source('raw_finance', 'expenses') }}
