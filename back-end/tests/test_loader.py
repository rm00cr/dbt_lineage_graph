"""AP-1 loader tests against the fixture artifacts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.config import ArtifactPair, PipelinesConfigError, load_pipelines_config, resolve_stage
from app.loader import LineageGraph, load_graph

CONTRACTS = "model.bestand_mfp.int_mfp_contracts"
SRC_CONTRACTS = "model.bestand_mfp.src_mfp_contracts"
RAW_CONTRACTS = "source.bestand_mfp.raw_mfp.contracts"
PREMIUM_CALC = "model.bestand_mfp.int_mfp_premium_calc"
CLAIMS_CASES = "model.schaden_claims.int_claims_cases"


def test_graph_loads_models_and_sources(graph: LineageGraph) -> None:
    assert len(graph.nodes) == 32  # 23 models + 6 raw sources + 3 imported outputs
    assert sum(1 for n in graph.nodes.values() if n.resource_type == "model") == 23
    assert sum(1 for n in graph.nodes.values() if n.resource_type == "source") == 9
    assert graph.catalog_loaded is True
    assert graph.adapter_type == "bigquery"
    assert graph.project_names == ["dbt_pnc"]  # every project has the same name


def test_stage_derivation(graph: LineageGraph) -> None:
    assert graph.nodes[SRC_CONTRACTS].stage == "src"
    assert graph.nodes[CONTRACTS].stage == "int"
    assert graph.nodes["model.bestand_mfp.out_mfp_portfolio_daily"].stage == "out"
    assert graph.nodes[RAW_CONTRACTS].stage == "src"
    assert graph.stages == ["src", "int", "out"]


def test_dbt_groups(graph: LineageGraph) -> None:
    assert graph.nodes[CONTRACTS].group == "contract"
    assert graph.nodes[CLAIMS_CASES].group == "claims"
    # sources have no dbt group: inherited from their consumers (raw contracts -> src_mfp_contracts)
    assert graph.nodes[RAW_CONTRACTS].group == "contract"
    assert graph.groups == ["claims", "contract", "finance", "partner", "premium"]


def test_layer_folders_define_the_stage() -> None:
    for folder, stage in (("01_source", "src"), ("02_intermediate", "int"), ("03_output", "out")):
        assert resolve_stage(name="anything", resource_type="model",
                             original_file_path=f"models/{folder}/sub/anything.sql") == stage
    # the folder wins over a misleading name prefix
    assert resolve_stage(name="src_helper", resource_type="model",
                         original_file_path="models/02_intermediate/src_helper.sql") == "int"


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
    assert graph.nodes["model.bestand_mfp.int_mfp_coverages"].materialization == "incremental"
    assert graph.nodes[PREMIUM_CALC].materialization == "ephemeral"
    assert graph.nodes[RAW_CONTRACTS].materialization == "source"
    assert graph.nodes[CONTRACTS].pipeline == "bestand_mfp"
    assert graph.nodes[CLAIMS_CASES].pipeline == "schaden_claims"
    assert graph.pipelines == ["bestand_mfp", "schaden_claims"]


def test_dependencies_and_inverted_dependents(graph: LineageGraph) -> None:
    node = graph.nodes[CONTRACTS]
    assert node.depends_on == [SRC_CONTRACTS, "model.bestand_mfp.src_mfp_partners"]
    assert CONTRACTS in graph.nodes[SRC_CONTRACTS].dependents
    # dependents are the inverted depends_on relation
    assert set(node.dependents) == {
        "model.bestand_mfp.int_mfp_contract_coverage",
        "model.bestand_mfp.out_mfp_customer_360",
        "model.bestand_mfp.out_mfp_premium_report",
        "model.bestand_mfp.out_mfp_contracts",
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
    # separate manifests: the import is a source of schaden_claims, stitched by table name
    imported = "source.schaden_claims.bestand_mfp.out_mfp_contracts"
    assert ("model.bestand_mfp.out_mfp_contracts", imported) in cross
    assert graph.nodes[imported].dependents == ["model.schaden_claims.src_claims_mfp_contracts"]
    assert len(cross) == 3
    # convention: only outputs cross a pipeline boundary, and always into the src layer
    assert all(graph.nodes[s].stage == "out" and graph.nodes[t].stage == "src" for s, t in cross)


# ---------------------------------------------------------------- multi-project stitching


def _project(tmp: Path, pipeline: str, *, models: list[dict[str, Any]],
             sources: list[dict[str, Any]] = (), project: str = "dbt_pnc") -> ArtifactPair:
    """A minimal dbt project. Like production, every project is called `dbt_pnc`; the
    pipeline is identified by the name it gets in pipelines.yaml."""
    nodes = {
        f"model.{project}.{m['name']}": {
            "resource_type": "model", "name": m["name"], "alias": m["name"],
            "database": m.get("database", f"{pipeline}-prd"), "schema": "s",
            "original_file_path": f"models/{m['folder']}/{m['name']}.sql",
            "config": {"materialized": "table"}, "depends_on": {"nodes": m.get("deps", [])},
        }
        for m in models
    }
    srcs = {
        f"source.{project}.{s['source_name']}.{s['table']}": {
            "resource_type": "source", "name": s["table"], "identifier": s["table"],
            "source_name": s["source_name"], "database": s["database"], "schema": s["schema"],
        }
        for s in sources
    }
    folder = tmp / pipeline
    folder.mkdir()
    manifest = {"metadata": {"project_name": project}, "nodes": nodes, "sources": srcs}
    (folder / "manifest.json").write_text(json.dumps(manifest))
    return ArtifactPair(name=pipeline, manifest=folder / "manifest.json")


def test_same_project_name_gives_separate_pipelines(tmp_path: Path) -> None:
    """All real projects are called `dbt_pnc`: the YAML name keeps them apart, and node ids
    are scoped by it so nothing is overwritten."""
    a = _project(tmp_path, "bestand", models=[{"name": "out_x", "folder": "03_output"},
                                              {"name": "int_y", "folder": "02_intermediate"}])
    b = _project(tmp_path, "claims", models=[
        {"name": "int_y", "folder": "02_intermediate"},  # same model name in both projects
        {"name": "out_z", "folder": "03_output", "deps": ["model.dbt_pnc.int_y"]},
    ])
    graph = load_graph([a, b])

    assert graph.pipelines == ["bestand", "claims"]
    assert graph.project_names == ["dbt_pnc"]
    assert {"model.bestand.int_y", "model.claims.int_y"} <= set(graph.nodes)
    assert len(graph.nodes) == 4
    assert graph.nodes["model.claims.int_y"].pipeline == "claims"
    # refs inside a manifest follow the scoping: claims' out_z reads claims' int_y
    assert graph.nodes["model.claims.out_z"].depends_on == ["model.claims.int_y"]
    assert ("model.bestand.int_y", "model.claims.out_z") not in graph.edges


def test_duplicate_pipeline_name_is_rejected(tmp_path: Path) -> None:
    a = _project(tmp_path, "p", models=[])
    with pytest.raises(ValueError, match="configured twice"):
        load_graph([a, a])


def test_pipelines_are_stitched_by_table_name_only(tmp_path: Path) -> None:
    upstream = _project(tmp_path, "up", models=[
        {"name": "out_orders", "folder": "03_output"},
        {"name": "int_secret", "folder": "02_intermediate"},
    ])
    downstream = _project(
        tmp_path, "down",
        # another GCP project and dataset than where `up` deploys: only the name counts
        sources=[{"source_name": "up", "table": "OUT_ORDERS", "database": "x-exp", "schema": "y"},
                 {"source_name": "raw", "table": "unrelated", "database": "raw", "schema": "r"}],
        models=[{"name": "src_orders", "folder": "01_source",
                 "deps": ["source.dbt_pnc.up.OUT_ORDERS"]}],
    )
    graph = load_graph([upstream, downstream])

    assert graph.pipelines == ["down", "up"]
    assert ("model.up.out_orders", "source.down.up.OUT_ORDERS") in graph.edges
    assert ("source.down.up.OUT_ORDERS", "model.down.src_orders") in graph.edges
    assert graph.nodes["source.down.raw.unrelated"].depends_on == []


def test_only_outputs_are_linked_and_ambiguity_stays_unlinked(tmp_path: Path) -> None:
    a = _project(tmp_path, "a", models=[{"name": "orders", "folder": "03_output"}])
    b = _project(tmp_path, "b", models=[{"name": "orders", "folder": "02_intermediate"}])
    c = _project(tmp_path, "c", models=[{"name": "orders", "folder": "03_output"}])
    reader = _project(tmp_path, "reader", models=[], sources=[
        {"source_name": "x", "table": "orders", "database": "d", "schema": "s"}])

    assert load_graph([a, b, reader]).nodes["source.reader.x.orders"].depends_on == ["model.a.orders"]
    assert load_graph([a, c, reader]).nodes["source.reader.x.orders"].depends_on == []
    # a non-output model is never a link target, even when it is the only name match
    assert load_graph([b, reader]).nodes["source.reader.x.orders"].depends_on == []


def test_source_on_passthrough_view_links_to_the_output(tmp_path: Path) -> None:
    """A pipeline may read another's output through a `{table}_v` passthrough view."""
    up = _project(tmp_path, "up", models=[{"name": "orders", "folder": "03_output"}])
    reader = _project(tmp_path, "reader", models=[], sources=[
        {"source_name": "x", "table": "ORDERS_V", "database": "d", "schema": "s"},
        {"source_name": "x", "table": "orders_vw", "database": "d", "schema": "s"}])
    graph = load_graph([up, reader])

    assert graph.nodes["source.reader.x.ORDERS_V"].depends_on == ["model.up.orders"]
    assert graph.nodes["source.reader.x.orders_vw"].depends_on == []

    # an output that is literally called `orders_v` is an exact match and wins
    exact = _project(tmp_path, "exact", models=[{"name": "orders_v", "folder": "03_output"}])
    assert load_graph([up, exact, reader]).nodes["source.reader.x.ORDERS_V"].depends_on == [
        "model.exact.orders_v"]


def test_pipelines_yaml(tmp_path: Path) -> None:
    absolute = (tmp_path / "elsewhere" / "manifest.json").resolve()
    (tmp_path / "pipelines.yaml").write_text(
        "pipelines:\n"
        "  - name: portfolio\n"
        "    dir: one\n"
        "  - name: claims\n"
        f"    manifest: '{absolute.as_posix()}'\n"
    )
    first, second = load_pipelines_config(tmp_path / "pipelines.yaml")
    assert (first.name, second.name) == ("portfolio", "claims")
    assert first.manifest == (tmp_path / "one" / "manifest.json").resolve()
    assert first.catalog == (tmp_path / "one" / "catalog.json").resolve()
    assert second.manifest == absolute and second.catalog is None

    for bad, message in (
        ("  - {name: a, catalog: c.json}\n", "needs 'dir', 'manifest' or 'project_dir'"),
        ("  - {dir: x}\n", "needs a 'name'"),
        ("  - {name: 'a.b', dir: x}\n", "may only contain"),
        ("  - {name: a, dir: x}\n  - {name: a, dir: y}\n", "used twice"),
    ):
        (tmp_path / "bad.yaml").write_text("pipelines:\n" + bad)
        with pytest.raises(PipelinesConfigError, match=message):
            load_pipelines_config(tmp_path / "bad.yaml")


def test_code_is_loaded(graph: LineageGraph) -> None:
    node = graph.nodes[CONTRACTS]
    assert node.raw_code is not None and "{{ ref('src_mfp_contracts') }}" in node.raw_code
    assert node.compiled_code is not None
    assert "{{" not in node.compiled_code  # compiled code has no jinja left
    assert "`pnc-analytics-prd`.mfp_source.src_mfp_contracts" in node.compiled_code
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


def test_folder_of_is_first_subfolder_below_layer() -> None:
    from app.config import folder_of

    assert folder_of("models/02_intermediate/contract_with_claim/int_x.sql") == "contract_with_claim"
    assert folder_of("models/01_source/claim/src_x.sql") == "claim"
    # numeric prefix on the layer folder is ignored, and deeper levels are flattened
    assert folder_of("models/02_intermediate/contract/sub/deep/int_x.sql") == "contract"
    assert folder_of("models\\03_output\\datamart\\out_x.sql") == "datamart"
    # directly in the layer folder -> no box
    assert folder_of("models/03_output/crpc_statistik_int.sql") is None
    # no layer folder at all
    assert folder_of("models/misc/x.sql") is None
    assert folder_of(None) is None


def test_source_takes_the_folder_of_its_consumers(tmp_path: Path) -> None:
    manifest = {
        "metadata": {"project_name": "p"},
        "nodes": {
            "model.p.src_a": {
                "name": "src_a", "resource_type": "model", "original_file_path": "models/01_source/claim/src_a.sql",
                "depends_on": {"nodes": ["source.p.ds.tbl_a", "source.p.ds.tbl_b"]},
            },
            "model.p.src_b": {
                "name": "src_b", "resource_type": "model", "original_file_path": "models/01_source/claim/src_b.sql",
                "depends_on": {"nodes": ["source.p.ds.tbl_b"]},
            },
            "model.p.src_c": {
                "name": "src_c", "resource_type": "model", "original_file_path": "models/01_source/adam/src_c.sql",
                "depends_on": {"nodes": ["source.p.ds.tbl_b"]},
            },
            "model.p.src_d": {
                "name": "src_d", "resource_type": "model", "original_file_path": "models/01_source/adam/src_d.sql",
                "depends_on": {"nodes": ["source.p.ds.tbl_a"]},
            },
        },
        "sources": {
            "source.p.ds.tbl_a": {"name": "tbl_a", "source_name": "ds", "identifier": "tbl_a", "resource_type": "source"},
            "source.p.ds.tbl_b": {"name": "tbl_b", "source_name": "ds", "identifier": "tbl_b", "resource_type": "source"},
            "source.p.ds.tbl_orphan": {"name": "tbl_orphan", "source_name": "ds", "identifier": "tbl_orphan", "resource_type": "source"},
        },
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    graph = load_graph([ArtifactPair(manifest=tmp_path / "manifest.json")])
    # tbl_b: claim (2 consumers) beats adam (1); tbl_a: tie claim/adam -> alphabetical
    assert graph.nodes["source.p.ds.tbl_b"].folder == "claim"
    assert graph.nodes["source.p.ds.tbl_a"].folder == "adam"
    assert graph.nodes["source.p.ds.tbl_orphan"].folder is None
