{#- Use the layer schema as is (mfp_source, mfp_output, ...) instead of dbt's
    <target_schema>_<custom_schema>: output tables keep a stable name across environments. -#}
{% macro generate_schema_name(custom_schema_name, node) -%}
    {{ (custom_schema_name or target.schema) | trim }}
{%- endmacro %}
