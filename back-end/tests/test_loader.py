"""AP-1 loader tests against the fixture artifacts."""

from __future__ import annotations

from app.config import resolve_stage
from app.loader import LineageGraph

CONTRACTS = "model.pnc_analytics.int_mfp_contracts"
SRC_CONTRACTS = "model.pnc_analytics.src_mfp_contracts"
RAW_CONTRACTS = "source.pnc_analytics.raw_mfp.contracts"
PREMIUM_CALC = "model.pnc_analytics.int_mfp_premium_calc"
CLAIMS_CASES = "model.pnc_analytics.int_claims_cases"


def test_graph_loads_models_and_sources(graph: LineageGraph) -> None:
    assert len(graph.nodes) == 25  # 19 models + 6 sources
    assert sum(1 for n in graph.nodes.values() if n.resource_type == "model") == 19
    assert sum(1 for n in graph.nodes.values() if n.resource_type == "source") == 6
    assert graph.catalog_loaded is True
    assert graph.adapter_type == "bigquery"
    assert graph.project_names == ["pnc_analytics"]


def test_stage_derivation(graph: LineageGraph) -> None:
    assert graph.nodes[SRC_CONTRACTS].stage == "src"
    assert graph.nodes[CONTRACTS].stage == "int"
    assert graph.nodes["model.pnc_analytics.out_mfp_portfolio_daily"].stage == "out"
    assert graph.nodes[RAW_CONTRACTS].stage == "src"
    assert graph.stages == ["src", "int", "out"]


def test_stage_fallbacks() -> None:
    assert resolve_stage(name="whatever", resource_type="source", original_file_path=None) == "src"
    assert resolve_stage(name="stg_x", resource_type="model", original_file_path=None) == "src"
    assert (
        resolve_stage(name="weird_name", resource_type="model",
                      original_file_path="models/p/intermediate/weird_name.sql") == "int"
    )
    assert (
        resolve_stage(name="weird_name", resource_type="model", original_file_path="models/p/x.sql",
                      tags=["stage:out"]) == "out"
    )
    assert resolve_stage(name="weird_name", resource_type="model", original_file_path=None) == "other"


def test_materialization_and_pipeline(graph: LineageGraph) -> None:
    assert graph.nodes[CONTRACTS].materialization == "table"
    assert graph.nodes[SRC_CONTRACTS].materialization == "view"
    assert graph.nodes["model.pnc_analytics.int_mfp_coverages"].materialization == "incremental"
    assert graph.nodes[PREMIUM_CALC].materialization == "ephemeral"
    assert graph.nodes[RAW_CONTRACTS].materialization == "source"
    assert graph.nodes[CONTRACTS].pipeline == "bestand_mfp"
    assert graph.nodes[CLAIMS_CASES].pipeline == "schaden_claims"
    assert graph.pipelines == ["bestand_mfp", "schaden_claims"]


def test_dependencies_and_inverted_dependents(graph: LineageGraph) -> None:
    node = graph.nodes[CONTRACTS]
    assert node.depends_on == [SRC_CONTRACTS, "model.pnc_analytics.src_mfp_partners"]
    assert CONTRACTS in graph.nodes[SRC_CONTRACTS].dependents
    # dependents are the inverted depends_on relation
    assert set(node.dependents) == {
        "model.pnc_analytics.int_mfp_contract_coverage",
        "model.pnc_analytics.out_mfp_customer_360",
        "model.pnc_analytics.out_mfp_premium_report",
        CLAIMS_CASES,
    }
    # sources have no parents but do have children
    assert graph.nodes[RAW_CONTRACTS].depends_on == []
    assert graph.nodes[RAW_CONTRACTS].dependents == [SRC_CONTRACTS]


def test_edges_are_unique_and_resolvable(graph: LineageGraph) -> None:
    assert len(graph.edges) == len(set(graph.edges))
    for source, target in graph.edges:
        assert source in graph.nodes
        assert target in graph.nodes
    assert (SRC_CONTRACTS, CONTRACTS) in graph.edges


def test_cross_pipeline_edges_exist(graph: LineageGraph) -> None:
    cross = [
        (s, t)
        for s, t in graph.edges
        if graph.nodes[s].pipeline != graph.nodes[t].pipeline
    ]
    assert (CONTRACTS, CLAIMS_CASES) in cross
    assert len(cross) >= 3


def test_code_is_loaded(graph: LineageGraph) -> None:
    node = graph.nodes[CONTRACTS]
    assert node.raw_code is not None and "{{ ref('src_mfp_contracts') }}" in node.raw_code
    assert node.compiled_code is not None
    assert "{{" not in node.compiled_code  # compiled code has no jinja left
    assert "`pnc-analytics-prd`.mfp_staging.src_mfp_contracts" in node.compiled_code
    assert graph.nodes[RAW_CONTRACTS].compiled_code is None


def test_columns_merge_catalog_types_with_manifest_docs(graph: LineageGraph) -> None:
    columns = graph.nodes[CONTRACTS].columns
    assert [c.name for c in columns][:3] == ["contract_id", "partner_id", "product_code"]
    by_name = {c.name: c for c in columns}
    assert by_name["annual_premium_chf"].type == "NUMERIC"
    assert by_name["annual_premium_chf"].description == "Gross annual premium in CHF."
    assert [c.index for c in columns] == list(range(1, len(columns) + 1))


def test_ephemeral_model_has_columns_without_catalog_entry(graph: LineageGraph) -> None:
    node = graph.nodes[PREMIUM_CALC]
    assert node.row_count is None and node.size_bytes is None
    assert [c.name for c in node.columns][:2] == ["annual_premium_chf", "base_rate"]
    assert all(c.type is None for c in node.columns)  # no catalog entry -> no types


def test_catalog_stats(graph: LineageGraph) -> None:
    node = graph.nodes[CONTRACTS]
    assert node.row_count == 4_812_004
    assert node.size_bytes == 1_073_741_824
