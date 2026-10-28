"""Contract tests for the HTTP layer (AP-1 / AP-4 endpoints)."""

from __future__ import annotations

from fastapi.testclient import TestClient

CONTRACTS = "model.pnc_analytics.int_mfp_contracts"
PREMIUM_CALC = "model.pnc_analytics.int_mfp_premium_calc"
RAW_CONTRACTS = "source.pnc_analytics.raw_mfp.contracts"


def test_health(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["catalog_loaded"] is True
    assert body["node_count"] == 25


def test_meta(client: TestClient) -> None:
    body = client.get("/api/meta").json()
    assert body["pipelines"] == ["bestand_mfp", "schaden_claims"]
    assert body["stages"] == ["src", "int", "out"]
    assert "incremental" in body["materializations"]
    assert body["model_count"] == 19 and body["source_count"] == 6
    assert "mfp" in body["tags"]


def test_graph_shape(client: TestClient) -> None:
    body = client.get("/api/graph").json()
    assert body["stats"]["node_count"] == len(body["nodes"]) == 25
    assert body["stats"]["edge_count"] == len(body["edges"]) == 30

    node = next(n for n in body["nodes"] if n["id"] == CONTRACTS)
    assert node == {
        "id": CONTRACTS,
        "name": "int_mfp_contracts",
        "stage": "int",
        "materialization": "table",
        "pipeline": "bestand_mfp",
        "resource_type": "model",
        "schema_name": "mfp_intermediate",
        "database": "pnc-analytics-prd",
        "description": node["description"],
        "tags": ["core", "mfp"],
        "column_count": 11,
        "execution_mode": "daily",
    }

    edge = next(e for e in body["edges"] if e["target"] == CONTRACTS)
    assert set(edge) == {"id", "source", "target", "cross_pipeline"}
    assert edge["id"] == f"{edge['source']}->{edge['target']}"
    assert any(e["cross_pipeline"] for e in body["edges"])


def test_graph_filters(client: TestClient) -> None:
    claims = client.get("/api/graph", params={"pipeline": "schaden_claims"}).json()
    assert {n["pipeline"] for n in claims["nodes"]} == {"schaden_claims"}
    # cross-pipeline edges are dropped when the other end is filtered out
    assert all(not e["cross_pipeline"] for e in claims["edges"])

    no_sources = client.get("/api/graph", params={"include_sources": "false"}).json()
    assert all(n["resource_type"] == "model" for n in no_sources["nodes"])
    assert no_sources["stats"]["node_count"] == 19

    out_only = client.get("/api/graph", params={"stage": "out"}).json()
    assert {n["stage"] for n in out_only["nodes"]} == {"out"}


def test_model_detail(client: TestClient) -> None:
    body = client.get(f"/api/model/{CONTRACTS}").json()
    assert body["name"] == "int_mfp_contracts"
    assert body["materialization"] == "table"
    assert body["execution_mode"] == "daily"
    assert body["compiled_code"].lower().startswith("with contracts as")
    assert "{{ config(materialized='table') }}" in body["raw_code"]
    assert [d["name"] for d in body["dependencies"]] == ["src_mfp_contracts", "src_mfp_partners"]
    assert "int_claims_cases" in [d["name"] for d in body["dependents"]]
    assert body["dbt_run_command"] == "dbt run --select int_mfp_contracts"
    assert body["stats"] == {"row_count": 4812004, "size_bytes": 1073741824}
    assert body["columns"][0] == {
        "name": "contract_id",
        "type": "STRING",
        "description": "Technical contract key.",
        "index": 1,
    }


def test_model_detail_bigquery_deeplink(client: TestClient) -> None:
    bq = client.get(f"/api/model/{CONTRACTS}").json()["bigquery"]
    assert bq["project"] == "pnc-analytics-prd"
    assert bq["dataset"] == "mfp_intermediate"
    assert bq["table"] == "int_mfp_contracts"
    assert bq["console_url"].startswith("https://console.cloud.google.com/bigquery?project=")
    assert "mfp_intermediate" in bq["console_url"]
    assert bq["query_url"] is not None and "q=" in bq["query_url"]

    # ephemeral models do not exist in the warehouse -> no deeplink
    assert client.get(f"/api/model/{PREMIUM_CALC}").json()["bigquery"] is None


def test_model_detail_by_name_and_source(client: TestClient) -> None:
    by_name = client.get("/api/model/int_mfp_contracts").json()
    assert by_name["id"] == CONTRACTS

    source = client.get(f"/api/model/{RAW_CONTRACTS}").json()
    assert source["resource_type"] == "source"
    assert source["compiled_code"] is None
    assert source["dbt_run_command"] is None
    assert [d["name"] for d in source["dependents"]] == ["src_mfp_contracts"]


def test_model_detail_404(client: TestClient) -> None:
    response = client.get("/api/model/model.pnc_analytics.does_not_exist")
    assert response.status_code == 404
    assert "not found" in response.json()["detail"]


def test_search_is_typo_tolerant(client: TestClient) -> None:
    body = client.get("/api/search", params={"q": "contrcts"}).json()
    names = [r["name"] for r in body["results"]]
    assert "int_mfp_contracts" in names
    assert body["results"][0]["score"] >= 0.6
    assert all(set(r) >= {"id", "name", "stage", "score", "matched_on"} for r in body["results"])

    exact = client.get("/api/search", params={"q": "out_claims_kpi_daily"}).json()
    assert exact["results"][0]["name"] == "out_claims_kpi_daily"
    assert exact["results"][0]["score"] == 1.0

    assert client.get("/api/search", params={"q": ""}).json()["results"] == []


def test_search_limit_and_tags(client: TestClient) -> None:
    limited = client.get("/api/search", params={"q": "mfp", "limit": 3}).json()
    assert len(limited["results"]) == 3

    tagged = client.get("/api/search", params={"q": "actuarial"}).json()
    assert tagged["results"][0]["name"] == "out_claims_reserve_report"
    assert tagged["results"][0]["matched_on"] == "tag"


def test_search_columns(client: TestClient) -> None:
    body = client.get("/api/search/columns", params={"q": "loss_ratio"}).json()
    assert body["results"], "expected at least one column hit"
    first = body["results"][0]
    assert first["matched_on"] == "column"
    assert first["column"]["name"] == "loss_ratio"
    assert first["column"]["type"] == "FLOAT64"
    assert {r["name"] for r in body["results"]} >= {
        "int_claims_loss_ratio",
        "out_claims_kpi_daily",
    }

    typo = client.get("/api/search/columns", params={"q": "premiun"}).json()
    assert any("premium" in r["column"]["name"] for r in typo["results"])


def test_reload_endpoint(client: TestClient) -> None:
    body = client.post("/api/reload").json()
    assert body["status"] == "ok"
    assert body["node_count"] == 25
