-- dq check: every payment belongs to a known claim. Returns the orphaned payments.
select payments.claim_id, payments.payment_type
from {{ ref('int_claims_payments') }} as payments
left join {{ ref('int_claims_cases') }} as cases
    on payments.claim_id = cases.claim_id
where cases.claim_id is null
