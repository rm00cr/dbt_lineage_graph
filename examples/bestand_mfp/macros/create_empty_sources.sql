{#
    Example projects ship without data. On DuckDB, every declared source of this project is
    created as an empty table (from the column names + data_types in its sources yml), so
    `dbt run --empty` can build all models and `dbt docs generate` gets a full catalog.

    On BigQuery (or any other target) this does nothing: there the sources are real tables.
    The data_types used in the sources yml (STRING, NUMERIC, INTEGER, DATE, TIMESTAMP,
    BOOLEAN) are valid in both DuckDB and BigQuery.
#}
{% macro create_empty_sources() %}
    {% if execute and target.type == 'duckdb' %}
        {% for source in graph.sources.values() %}
            {% set columns = [] %}
            {% for column in source.columns.values() %}
                {% do columns.append(adapter.quote(column.name) ~ ' ' ~ (column.data_type or 'STRING')) %}
            {% endfor %}
            {% if columns %}
                {% do run_query('create schema if not exists ' ~ adapter.quote(source.schema)) %}
                {% do run_query(
                    'create table if not exists ' ~ adapter.quote(source.schema) ~ '.' ~ adapter.quote(source.identifier)
                    ~ ' (' ~ columns | join(', ') ~ ')'
                ) %}
            {% endif %}
        {% endfor %}
    {% endif %}
{% endmacro %}
