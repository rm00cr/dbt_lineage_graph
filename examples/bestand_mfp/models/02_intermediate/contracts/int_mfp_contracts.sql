{#- full mode: rebuilt from the full export; incremental mode: merges the change feed -#}
{{ config(
    materialized='table' if var('full_mode') else 'incremental',
    unique_key='contract_id',
) }}

with contracts as (
{% if var('full_mode') %}
    select
        contract_id,
        partner_id,
        product_code,
        contract_status,
        valid_from,
        valid_to,
        annual_premium_chf,
        _loaded_at
    from {{ ref('src_mfp_contracts') }}
{% else %}
    select
        contract_id,
        partner_id,
        product_code,
        contract_status,
        valid_from,
        valid_to,
        annual_premium_chf,
        _loaded_at
    from {{ ref('src_mfp_contract_changes') }}
    where not is_deleted
    {% if is_incremental() %}
        and _loaded_at > (select max(_loaded_at) from {{ this }})
    {% endif %}
{% endif %}
),

partners as (
    select
        partner_id,
        partner_type,
        age_years,
        canton,
        language_code
    from {{ ref('src_mfp_partners') }}
)

select
    contracts.contract_id,
    contracts.partner_id,
    contracts.product_code,
    contracts.contract_status,
    contracts.valid_from,
    contracts.valid_to,
    contracts.annual_premium_chf,
    partners.partner_type,
    partners.age_years,
    partners.canton,
    partners.language_code,
    contracts._loaded_at
from contracts
left join partners
    on contracts.partner_id = partners.partner_id
