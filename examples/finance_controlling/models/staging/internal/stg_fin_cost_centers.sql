select
    cost_center_id,
    cost_center_name,
    lower(department)   as department
from {{ source('raw_finance', 'cost_centers') }}
where is_active
