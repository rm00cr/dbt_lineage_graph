"""Derive a "development branch" state of the bestand_mfp pipeline, for the state comparison.

    python fixtures/generate_dev_state.py      -> fixtures/dev_state/{manifest,catalog}.json

Upload the two files with *Compare* in the UI to see the diff. An upload is one pipeline
(= one dbt project); it replaces the running bestand_mfp, schaden_claims stays as it is.
The changes are chosen to hit every case the diff distinguishes (see back-end/app/diff.py):

    added     out_mfp_churn_risk                (new model on top of int_mfp_contracts)
    removed   out_mfp_customer_360              (dropped mart, its two edges go with it)
    modified  int_mfp_contracts                 (SQL changed: new column `is_active`)
              int_mfp_coverages                 (materialization incremental -> table)
              out_mfp_contracts                 (catalog: column type changed)
              source raw_mfp.tariffs            (source moved to another schema)

and it re-targets *every* model to a dev database / schema with dev compiled SQL, the way
`dbt compile --target dev` would. That noise must NOT show up as a change.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = HERE / "bestand_mfp"
OUT = HERE / "dev_state"



def build(manifest: dict, catalog: dict) -> tuple[dict, dict]:
    manifest, catalog = copy.deepcopy(manifest), copy.deepcopy(catalog)
    # raw dbt ids carry the dbt project_name (shared by all pipelines, e.g. dbt_pnc)
    project = manifest["metadata"]["project_name"]
    P = f"model.{project}."
    nodes, cat_nodes = manifest["nodes"], catalog["nodes"]
    manifest["metadata"]["generated_at"] = "2026-11-10T09:30:00Z"
    catalog["metadata"]["generated_at"] = "2026-11-10T09:30:00Z"

    # dev target noise: other database / schema, compiled SQL pointing at dev relations
    for node in nodes.values():
        if node.get("resource_type") != "model":
            continue
        node["database"] = "pnc-analytics-dev"
        node["schema"] = "dbt_dev_" + (node.get("schema") or "")
        if node.get("compiled_code"):
            node["compiled_code"] = node["compiled_code"].replace("pnc-analytics-prd", "pnc-analytics-dev")
    for entry in cat_nodes.values():
        entry.setdefault("metadata", {})["database"] = "pnc-analytics-dev"

    # removed
    gone = P + "out_mfp_customer_360"
    del nodes[gone]
    cat_nodes.pop(gone, None)

    # modified: SQL
    contracts = nodes[P + "int_mfp_contracts"]
    assert "    c.contract_status,\n" in contracts["raw_code"], "fixture SQL changed, adapt the dev edit"
    contracts["raw_code"] = contracts["raw_code"].replace(
        "    c.contract_status,\n",
        "    c.contract_status,\n    c.contract_status = 'active' as is_active,  -- dev: flag active contracts\n",
        1,
    )
    cat_nodes[P + "int_mfp_contracts"]["columns"]["is_active"] = {
        "type": "BOOL",
        "index": 99,
        "name": "is_active",
        "comment": None,
    }

    # modified: config
    coverages = nodes[P + "int_mfp_coverages"]
    coverages["config"]["materialized"] = "table"

    # modified: column type in the catalog
    out_contracts = cat_nodes[P + "out_mfp_contracts"]["columns"]
    first = next(iter(out_contracts.values()))
    first["type"] = "INT64" if first.get("type") != "INT64" else "STRING"

    # modified: a source moved
    tariffs = manifest["sources"][f"source.{project}.raw_mfp.tariffs"]
    tariffs["schema"] = "raw_mfp_v2"

    # added
    template = nodes[P + "out_mfp_contracts"]
    new_id = P + "out_mfp_churn_risk"
    nodes[new_id] = {
        **copy.deepcopy(template),
        "unique_id": new_id,
        "name": "out_mfp_churn_risk",
        "alias": "out_mfp_churn_risk",
        "description": "Contracts likely to be cancelled in the next 90 days (dev prototype).",
        "original_file_path": template["original_file_path"].replace("out_mfp_contracts", "out_mfp_churn_risk"),
        "path": template.get("path", "").replace("out_mfp_contracts", "out_mfp_churn_risk"),
        "raw_code": "select contract_id, partner_id\nfrom {{ ref('int_mfp_contracts') }}\nwhere status = 'active'\n",
        "compiled_code": None,
        "depends_on": {"nodes": [P + "int_mfp_contracts"], "macros": []},
    }
    nodes[new_id]["config"] = {**template["config"], "materialized": "view"}
    cat_nodes[new_id] = {
        "metadata": {"type": "view", "schema": "dbt_dev_mfp_output", "name": "out_mfp_churn_risk"},
        "columns": {
            "contract_id": {"type": "STRING", "index": 1, "name": "contract_id", "comment": None},
            "partner_id": {"type": "STRING", "index": 2, "name": "partner_id", "comment": None},
        },
        "stats": {},
        "unique_id": new_id,
    }
    return manifest, catalog


def main() -> None:
    manifest = json.loads((BASE / "manifest.json").read_text(encoding="utf-8"))
    catalog = json.loads((BASE / "catalog.json").read_text(encoding="utf-8"))
    dev_manifest, dev_catalog = build(manifest, catalog)
    OUT.mkdir(exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(dev_manifest, indent=2) + "\n", encoding="utf-8")
    (OUT / "catalog.json").write_text(json.dumps(dev_catalog, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT / 'manifest.json'} and {OUT / 'catalog.json'}")


if __name__ == "__main__":
    main()
