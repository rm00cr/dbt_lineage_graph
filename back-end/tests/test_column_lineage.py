"""Column-level lineage (2.3): parser behaviour on small inline SQL cases + the fixtures."""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

import pytest

from app.column_lineage import ColumnLineageCache, ColumnLineageIndex, build_column_lineage, dialect_for
from app.config import DEFAULT_PIPELINES_CONFIG, Settings
from app.loader import Column, LineageGraph, LineageNode, _link
from app.service import GraphService

DB = "proj"


def _source(name: str, columns: list[str]) -> LineageNode:
    return LineageNode(
        id=f"source.p.raw.{name}",
        name=f"raw.{name}",
        stage="src",
        materialization="source",
        pipeline="p",
        resource_type="source",
        project="p",
        schema_name="raw",
        database=DB,
        alias=name,
        columns=[Column(name=c, type="STRING") for c in columns],
    )


def _model(
    name: str,
    sql: str,
    depends_on: list[str],
    columns: list[str] | None = None,
    materialization: str = "table",
) -> LineageNode:
    return LineageNode(
        id=f"model.p.{name}",
        name=name,
        stage="int",
        materialization=materialization,
        pipeline="p",
        resource_type="model",
        project="p",
        schema_name="analytics",
        database=DB,
        alias=name,
        compiled_code=sql,
        columns=[Column(name=c, type="STRING") for c in (columns or [])],
        depends_on=depends_on,
    )


def _build(*nodes: LineageNode, cache: ColumnLineageCache | None = None) -> ColumnLineageIndex:
    graph = LineageGraph(adapter_type="bigquery")
    for node in copy.deepcopy(nodes):
        graph.nodes[node.id] = node
    _link(graph)
    return build_column_lineage(graph, cache=cache)


def _snapshot(index: ColumnLineageIndex) -> tuple[list, list]:
    """Everything a build produces, comparable between builds."""
    return (
        sorted((e.id, e.kind, e.expression) for e in index.edges),
        sorted((m.model_id, m.status, m.error, m.warnings) for m in index.models.values()),
    )


def _edges(index: ColumnLineageIndex, target: str) -> dict[tuple[str, str], str]:
    """{(source node name suffix, source column): kind} for every column of ``target``."""
    return {
        (e.source_model.split(".")[-1], f"{e.source_column}->{e.target_column}"): e.kind
        for e in index.edges
        if e.target_model == f"model.p.{target}"
    }


ORDERS = _source("orders", ["order_id", "customer_id", "amount", "status"])
CUSTOMERS = _source("customers", ["customer_id", "name", "country"])


def test_edge_kinds() -> None:
    sql = f"""
        select
            o.order_id,
            o.customer_id as buyer_id,
            upper(o.status) as status,
            sum(o.amount) as total_amount,
            current_date() as loaded_on
        from `{DB}`.raw.orders o
        group by 1, 2, 3
    """
    index = _build(ORDERS, _model("m", sql, [ORDERS.id]))
    assert _edges(index, "m") == {
        ("orders", "order_id->order_id"): "passthrough",
        ("orders", "customer_id->buyer_id"): "rename",
        ("orders", "status->status"): "transform",
        ("orders", "amount->total_amount"): "aggregate",
    }
    agg = next(e for e in index.edges if e.target_column == "total_amount")
    assert agg.expression is not None and "sum" in agg.expression.lower()
    assert index.models["model.p.m"].status == "ok"


def test_using_join_and_unqualified_columns_need_the_schema() -> None:
    sql = f"""
        select order_id, name, country, amount
        from `{DB}`.raw.orders
        join `{DB}`.raw.customers using (customer_id)
    """
    index = _build(ORDERS, CUSTOMERS, _model("m", sql, [ORDERS.id, CUSTOMERS.id]))
    assert set(_edges(index, "m")) == {
        ("orders", "order_id->order_id"),
        ("customers", "name->name"),
        ("customers", "country->country"),
        ("orders", "amount->amount"),
    }


def test_select_star_is_expanded() -> None:
    index = _build(CUSTOMERS, _model("m", f"select * from `{DB}`.raw.customers", [CUSTOMERS.id]))
    assert {k[1] for k in _edges(index, "m")} == {
        "customer_id->customer_id",
        "name->name",
        "country->country",
    }


def test_cte_chain_keeps_the_strongest_kind() -> None:
    sql = f"""
        with base as (select customer_id, amount * 1.1 as gross from `{DB}`.raw.orders),
             agg as (select customer_id, sum(gross) as revenue from base group by 1)
        select customer_id, revenue from agg
    """
    index = _build(ORDERS, _model("m", sql, [ORDERS.id]))
    assert _edges(index, "m") == {
        ("orders", "customer_id->customer_id"): "passthrough",
        ("orders", "amount->revenue"): "aggregate",
    }


def test_models_without_catalog_columns_still_feed_downstream() -> None:
    first = _model("first", f"select order_id, amount from `{DB}`.raw.orders", [ORDERS.id], columns=[])
    second = _model("second", f"select * from `{DB}`.analytics.first", [first.id])
    index = _build(ORDERS, first, second)
    assert set(_edges(index, "second")) == {
        ("first", "order_id->order_id"),
        ("first", "amount->amount"),
    }
    up = index.trace(second.id, "amount", "up")
    assert (ORDERS.id, "amount") in up.nodes and up.nodes[(ORDERS.id, "amount")] == 2


def test_ephemeral_cte_is_kept_as_a_hop() -> None:
    eph = _model(
        "eph_orders",
        f"select order_id, amount from `{DB}`.raw.orders where status = 'ok'",
        [ORDERS.id],
        columns=[],
        materialization="ephemeral",
    )
    sql = """
        with __dbt__cte__eph_orders as (
            select order_id, amount from `proj`.raw.orders where status = 'ok'
        )
        select order_id, amount * 2 as double_amount from __dbt__cte__eph_orders
    """
    index = _build(ORDERS, eph, _model("m", sql, [eph.id]))
    assert _edges(index, "m") == {
        ("eph_orders", "order_id->order_id"): "passthrough",
        ("eph_orders", "amount->double_amount"): "transform",
    }


def test_partly_documented_columns_are_completed_from_the_sql() -> None:
    # an ephemeral model never reaches the catalog: its only columns are the documented ones
    eph = _model(
        "eph_orders",
        f"select order_id, customer_id, amount from `{DB}`.raw.orders",
        [ORDERS.id],
        columns=["amount"],
        materialization="ephemeral",
    )
    sql = f"""
        with __dbt__cte__eph_orders as (
            select order_id, customer_id, amount from `{DB}`.raw.orders
        )
        select e.customer_id, sum(e.amount) as revenue
        from __dbt__cte__eph_orders as e
        group by 1
    """
    index = _build(ORDERS, eph, _model("m", sql, [eph.id]))
    assert index.models["model.p.m"].status == "ok", index.models["model.p.m"]
    assert _edges(index, "m") == {
        ("eph_orders", "customer_id->customer_id"): "passthrough",
        ("eph_orders", "amount->revenue"): "aggregate",
    }


def test_unknown_relation_marks_model_partial() -> None:
    sql = f"select o.order_id, x.flag from `{DB}`.raw.orders o join `{DB}`.raw.unknown x using (order_id)"
    index = _build(ORDERS, _model("m", sql, [ORDERS.id]))
    status = index.models["model.p.m"]
    assert status.status == "partial"
    assert any("unknown" in w for w in status.warnings)
    assert ("orders", "order_id->order_id") in _edges(index, "m")


def test_broken_sql_fails_softly() -> None:
    index = _build(ORDERS, _model("m", "select from where (", [ORDERS.id]), _model("e", "  ", []))
    assert index.models["model.p.m"].status == "failed"
    assert index.models["model.p.m"].error
    assert index.models["model.p.e"].status == "skipped"
    assert index.coverage == 0.0


def test_trace_directions_and_depth() -> None:
    a = _model("a", f"select order_id, amount from `{DB}`.raw.orders", [ORDERS.id])
    b = _model("b", f"select order_id, amount from `{DB}`.analytics.a", [a.id])
    c = _model("c", f"select sum(amount) as total from `{DB}`.analytics.b", [b.id])
    index = _build(ORDERS, a, b, c)

    down = index.trace(ORDERS.id, "amount", "down")
    assert down.nodes == {
        (ORDERS.id, "amount"): 0,
        (a.id, "amount"): 1,
        (b.id, "amount"): 2,
        (c.id, "total"): 3,
    }
    assert len(index.trace(ORDERS.id, "amount", "down", depth=1).nodes) == 2
    both = index.trace(b.id, "amount", "both")
    assert (ORDERS.id, "amount") in both.nodes and (c.id, "total") in both.nodes
    assert index.counts(b.id, "amount") == (1, 1)


def test_dialect_mapping() -> None:
    assert dialect_for("bigquery") == "bigquery"
    assert dialect_for("sqlserver") == "tsql"
    assert dialect_for("not-a-dialect") is None
    assert dialect_for(None) is None


def test_fixtures_known_edges(graph: LineageGraph) -> None:
    index = build_column_lineage(graph)
    assert index.coverage == 1.0
    edge = next(
        e
        for e in index.edges
        if e.target_model == "model.bestand_mfp.out_mfp_portfolio_daily"
        and e.target_column == "written_premium_chf"
    )
    assert edge.source_model == "model.bestand_mfp.int_mfp_contract_coverage"
    assert edge.source_column == "annual_premium_chf"
    assert edge.kind == "aggregate"


def test_fixtures_trace_crosses_pipelines(graph: LineageGraph) -> None:
    """The import of another pipeline's output is a source stitched by table name; a column
    trace must run through it into the upstream pipeline."""
    index = build_column_lineage(graph)
    trace = index.trace("model.schaden_claims.src_claims_mfp_contracts", "canton", direction="up")
    assert ("source.schaden_claims.bestand_mfp.out_mfp_contracts", "canton") in trace.nodes
    assert ("model.bestand_mfp.out_mfp_contracts", "canton") in trace.nodes
    hop = next(e for e in trace.edges if e.target_model.startswith("source.schaden_claims"))
    assert hop.kind == "passthrough"


# --------------------------------------------------------------------------------------
# per-model cache
# --------------------------------------------------------------------------------------

# every path through the builder: catalog columns, registered select lists, ephemeral
# inlining, partial and failed models
CACHE_CASE = (
    ORDERS,
    CUSTOMERS,
    _model("first", f"select order_id, amount from `{DB}`.raw.orders", [ORDERS.id], columns=[]),
    _model("second", f"select * from `{DB}`.analytics.first", ["model.p.first"]),
    _model(
        "eph",
        f"select order_id, customer_id, amount from `{DB}`.raw.orders",
        [ORDERS.id],
        columns=["amount"],
        materialization="ephemeral",
    ),
    _model(
        "agg",
        f"""with __dbt__cte__eph as (select order_id, customer_id, amount from `{DB}`.raw.orders)
            select e.customer_id, c.name, sum(e.amount) as revenue
            from __dbt__cte__eph as e join `{DB}`.raw.customers c using (customer_id)
            group by 1, 2""",
        ["model.p.eph", CUSTOMERS.id],
    ),
    _model(
        "partial",
        f"select o.order_id, x.flag from `{DB}`.raw.orders o join `{DB}`.raw.nope x using (order_id)",
        [ORDERS.id],
    ),
    _model("broken", "select from where (", [ORDERS.id]),
)
CACHE_CASE_MODELS = sum(1 for n in CACHE_CASE if n.resource_type == "model")


def test_cached_build_equals_a_fresh_build() -> None:
    cache = ColumnLineageCache()
    cold = _build(*CACHE_CASE, cache=cache)
    assert _snapshot(cold) == _snapshot(_build(*CACHE_CASE))
    statuses = {m.status for m in cold.models.values()}
    assert statuses == {"ok", "partial", "failed"}, statuses
    # the broken model fails while parsing, before it has a cache key
    assert (cache.hits, cache.misses) == (0, CACHE_CASE_MODELS - 1)

    warm = _build(*CACHE_CASE, cache=cache)
    assert cache.hits == CACHE_CASE_MODELS - 1
    assert _snapshot(warm) == _snapshot(cold)
    # registered select lists are replayed too: `second` still resolves `first`'s columns
    assert set(_edges(warm, "second")) == {("first", "order_id->order_id"), ("first", "amount->amount")}


def test_cache_reparses_downstream_of_changed_columns() -> None:
    model = _model("m", f"select * from `{DB}`.raw.customers", [CUSTOMERS.id])
    cache = ColumnLineageCache()
    _build(CUSTOMERS, model, cache=cache)

    wider = _source("customers", ["customer_id", "name", "country", "segment"])
    index = _build(wider, model, cache=cache)
    assert cache.misses == 2  # the same SQL, but `select *` now means another column
    assert ("customers", "segment->segment") in _edges(index, "m")

    changed_sql = replace(model, compiled_code=f"select name from `{DB}`.raw.customers")
    assert set(_edges(_build(wider, changed_sql, cache=cache), "m")) == {("customers", "name->name")}
    assert cache.misses == 3


def test_cache_survives_a_restart_through_its_file(tmp_path: Path) -> None:
    path = tmp_path / "sub" / "cache.json"
    first = ColumnLineageCache(path)
    cold = _build(*CACHE_CASE, cache=first)
    first.save()
    assert path.is_file()

    second = ColumnLineageCache(path)
    assert len(second) == len(first) > 0
    assert _snapshot(_build(*CACHE_CASE, cache=second)) == _snapshot(cold)
    assert second.misses == 0


def test_cache_file_from_another_version_or_broken_is_ignored(tmp_path: Path) -> None:
    path = tmp_path / "cache.json"
    cache = ColumnLineageCache(path)
    _build(*CACHE_CASE, cache=cache)
    cache.save()

    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["version"] = "0/old"
    path.write_text(json.dumps(payload), encoding="utf-8")
    assert len(ColumnLineageCache(path)) == 0

    path.write_text("{ not json", encoding="utf-8")
    assert len(ColumnLineageCache(path)) == 0


def test_service_reload_reuses_the_cache_and_writes_its_file(settings: Settings, tmp_path: Path) -> None:
    path = tmp_path / "column_lineage.json"
    service = GraphService(replace(settings, column_lineage_cache=path))
    before = _snapshot(service.column_lineage)
    misses = service.column_cache.misses
    assert misses > 0 and path.is_file()

    service.reload()  # e.g. after a dbt run: the artifacts are read again, nothing changed
    assert service.column_cache.misses == misses
    assert _snapshot(service.column_lineage) == before

    restarted = GraphService(replace(settings, column_lineage_cache=path))
    assert restarted.column_cache.misses == 0
    assert _snapshot(restarted.column_lineage) == before


def test_settings_read_the_cache_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PIPELINES_CONFIG", str(DEFAULT_PIPELINES_CONFIG))
    monkeypatch.setenv("COLUMN_LINEAGE_CACHE", str(tmp_path / "c.json"))
    assert Settings.from_env().column_lineage_cache == tmp_path / "c.json"
    monkeypatch.delenv("COLUMN_LINEAGE_CACHE")
    assert Settings.from_env().column_lineage_cache is None


def test_cache_drops_least_recently_used_entries() -> None:
    cache = ColumnLineageCache(max_entries=2)
    for key in ("a", "b", "c"):
        cache.put(key, {"n": key})
    assert len(cache) == 2
    assert cache.get("a") is None
    assert cache.get("c") == {"n": "c"}
