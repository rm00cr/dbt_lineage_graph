-- dq check: no contract in the output has a negative annual premium (warn only).
-- Sits directly in tests/, so the lineage explorer places it with the model it reads.
{{ config(severity='warn') }}

select contract_id, annual_premium_chf
from {{ ref('out_mfp_contracts') }}
where annual_premium_chf < 0
