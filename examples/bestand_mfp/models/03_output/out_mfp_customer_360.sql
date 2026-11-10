{{ config(materialized='view') }}

select
    partners.partner_id,
    partners.partner_type,
    partners.age_years,
    partners.canton,
    partners.language_code,
    count(distinct contracts.contract_id)                            as contract_count,
    sum(contracts.annual_premium_chf)                                as total_premium_chf,
    min(contracts.valid_from)                                        as customer_since,
    {{ dbt.listagg('distinct contracts.product_code', "', '") }}     as product_codes
from {{ ref('src_mfp_partners') }} as partners
inner join {{ ref('int_mfp_contracts') }} as contracts
    on partners.partner_id = contracts.partner_id
group by 1, 2, 3, 4, 5
