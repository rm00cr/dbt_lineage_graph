{{ config(materialized='incremental', unique_key=['snapshot_date', 'product_code', 'canton']) }}

select
    current_date                                                        as snapshot_date,
    product_code,
    canton,
    sum(claim_count)                                                    as claim_count,
    sum(paid_chf)                                                       as paid_chf,
    sum(reserve_chf)                                                    as reserve_chf,
    sum(written_premium_chf)                                            as written_premium_chf,
    (sum(paid_chf) + sum(reserve_chf)) / nullif(sum(written_premium_chf), 0) as loss_ratio
from {{ ref('int_claims_loss_ratio') }}
group by 1, 2, 3
