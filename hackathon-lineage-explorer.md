# Hackathon: Interaktiver dbt Lineage Explorer (PnC)

> **Dauer:** 1.5 Tage · **Team:** 4 Personen · **Stack:** React (Frontend), Python-API (Backend) · **Graph-Lib:** React Flow (Default, siehe Entscheid unten)

---

## 1. Ausgangslage & Vision

Unsere dbt-Pipelines im PnC-Umfeld wachsen in Umfang und Komplexität. Die heutigen Lineage-Tools sind statisch, schwer lesbar und zwingen zum ständigen Kontextwechsel. Ziel des Hackathons ist es, die Lineage-Darstellung von einer reinen Übersicht zu einem **interaktiven Explorations-Werkzeug** weiterzuentwickeln.

**Kernidee:** Modelle lassen sich direkt im Graphen öffnen (Sliding Overlay), Stages werden farblich klar unterschieden, das Rendering wird strukturierter – aus dem statischen Diagramm wird ein lebendiges Verständnis-Tool.

**Erwarteter Mehrwert**
- **Schnelleres Pipeline-Verständnis** – Datenflüsse auf einen Blick, ohne Tool-Wechsel.
- **Bessere Impact-Analyse** – "Was hängt von diesem Modell ab?" wird sofort sichtbar.
- **Niedrigere Einstiegshürde** – schnelleres Onboarding ins PnC-Datenmodell.
- **Grundlage für die Zukunft** – Column-Level Lineage als nächster Schritt.

---

## 2. Technische Grundsatzentscheide

| Thema | Entscheid | Begründung |
|---|---|---|
| **Frontend** | React + TypeScript + Vite | Schnelles Setup, HMR, gutes Hackathon-Tempo. |
| **Graph-Lib** | **React Flow** (Default) | Beste Unterstützung für Custom Nodes, Overlays, Focus Mode, Mini-Map out-of-the-box. Alternative *Graphology/Sigma* nur falls >5k Nodes Performance-Probleme machen. |
| **Backend** | Python (FastAPI) | Liest/parst dbt-Artefakte, einfache JSON-API, gut testbar. |
| **Datenquelle (Start)** | `manifest.json` + `catalog.json` | Enthalten Graph, kompilierten Code, Materialisierung, Schema. Keine Live-DB nötig für MVP. |
| **Datenquelle (Erweiterung)** | BigQuery `INFORMATION_SCHEMA`, dbt-Metadaten | Für Live-Schema, Kosten, Deeplinks – erst nach MVP. |

### Warum manifest + catalog als Start ideal sind
- `manifest.json`: Knoten (Modelle, Sources), **`depends_on`** (Dependencies), **`compiled_code`**, **`config.materialized`**, Beschreibung, Tags, `schema`/`database`.
- `catalog.json`: **Spalten + Datentypen** pro Tabelle (für Prio-2-Schema-Features), aus `dbt docs generate`.

Damit sind **Prio 1 fast vollständig** und **Teile von Prio 2** ohne externe Abhängigkeiten abdeckbar.

---

## 3. Architektur & Schnittstelle (das Herzstück fürs parallele Arbeiten)

Damit Front- und Backend **unabhängig** arbeiten können, definieren wir zuerst gemeinsam den **API-Contract**. Danach kann das Frontend gegen Mock-Daten entwickeln und das Backend gegen den Contract liefern.

### 3.1 Vorgeschlagener API-Contract (v0 – zuerst gemeinsam fixieren!)

```jsonc
// GET /api/graph  -> gesamter Lineage-Graph (schlank, für Rendering)
{
  "nodes": [
    {
      "id": "model.project.int_mfp_contracts",
      "name": "int_mfp_contracts",
      "stage": "int",                     // src | int | out (abgeleitet aus Pfad/Prefix)
      "materialization": "table",         // table | view | ephemeral | incremental
      "pipeline": "df-bestand-mfp"        // für lineage-across-pipelines
    }
  ],
  "edges": [
    { "source": "model.project.src_x", "target": "model.project.int_mfp_contracts" }
  ]
}

// GET /api/model/{id}  -> Detail für Overlay (lazy geladen)
{
  "id": "model.project.int_mfp_contracts",
  "name": "int_mfp_contracts",
  "stage": "int",
  "materialization": "table",
  "description": "...",
  "compiled_code": "SELECT ...",         // kompilierter SQL-Code
  "raw_code": "SELECT ...",
  "dependencies": ["model.project.src_x"],   // direkte Upstreams
  "dependents": ["model.project.out_y"],      // direkte Downstreams
  "columns": [                              // aus catalog.json (Prio 2)
    { "name": "contract_id", "type": "STRING", "description": "..." }
  ],
  "bigquery": { "project": "...", "dataset": "...", "table": "..." }  // Prio 3 Deeplink
}

// GET /api/search?q=...  -> Fuzzy-Search über Modellnamen (Prio 1)
// GET /api/search/columns?q=...  -> Suche über Spalten (Prio 2)
```

### 3.2 Schichtenmodell

```
┌─────────────────────────── Frontend (React) ───────────────────────────┐
│  GraphCanvas (React Flow)   │  SidePanel/Overlay  │  SearchBar  │  Toolbar │
│  - Custom Nodes (Stage-Farbe)│  - Compiled Code    │  - Fuzzy    │  - Focus │
│  - Focus Mode / Highlight    │  - Deps/Dependents  │             │  - Mini  │
└───────────────┬─────────────────────────────────────────────────────────┘
                │  REST/JSON (Contract v0)
┌───────────────┴─────────────────────── Backend (FastAPI) ────────────────┐
│  Loader (manifest+catalog)  │  GraphService  │  SearchIndex  │  (BQ-Adapter)│
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Features – ausformuliert & nach Prio

### Prio 1 – MVP (muss am Ende stehen)
| # | Feature | Ausformuliert | Schicht |
|---|---|---|---|
| 1.1 | **Navigation im Graphen** | Pan, Zoom, Zoom-to-fit, Klick zum Zentrieren eines Modells, flüssiges Verhalten auch bei vielen Knoten. | FE |
| 1.2 | **Kompilierten Source-Code lesen** | Beim Öffnen eines Modells wird der kompilierte SQL-Code im Side-Overlay angezeigt (Syntax-Highlighting, Copy-Button). | FE + BE |
| 1.3 | **Dependencies & Dependents auflisten** | Im Overlay zwei explizite Listen: direkte Upstreams und Downstreams, jeweils klickbar (navigiert/highlightet im Graphen). | FE + BE |
| 1.4 | **Focus Mode** | Nicht-gehighlightete Modelle ausblenden/abdunkeln; nur das selektierte Modell + dessen Lineage-Pfad bleibt sichtbar. | FE |
| 1.5 | **Suchfunktion (inkl. Fuzzy)** | Suchleiste, die Modelle per Namen findet (fuzzy, tolerant gegen Tippfehler); Treffer wird im Graph zentriert/gehighlightet. | FE + BE |
| 1.6 | **Materialisierung sichtbar** | Node zeigt visuell, ob Table/View/Incremental (Icon/Badge/Form). | FE (Daten aus BE) |
| 1.7 | **Multi-Selection ("+ model +")** | Mehrere Modelle gleichzeitig selektieren; dbt-ähnliche Syntax `+model+` (Upstream+Downstream) zur Selektion eines Lineage-Subsets. | FE |
| 1.8 | **Grössere Modellschrift** | Lesbarkeit: Label-Grösse erhöhen bzw. zoom-abhängig skalieren. | FE |

### Prio 2 – Spalten & erweiterte Lineage
| # | Feature | Ausformuliert | Schicht |
|---|---|---|---|
| 2.1 | **Schema anzeigen** | Spaltenliste mit Datentyp (+ Beschreibung) im Overlay, aus `catalog.json`. | FE + BE |
| 2.2 | **Spalten-/Attribut-Suche** | Suche findet Modelle anhand einer Spalte/eines Attributs. | FE + BE |
| 2.3 | **Column-Level Lineage** | Verfolgung einzelner Spalten über Modelle hinweg (sqlglot-basiertes Parsing). *Hoher Aufwand – Stretch Goal.* | BE (+ FE Viz) |
| 2.4 | **Lineage across Pipelines** | Kanten/Modelle über mehrere dbt-Projekte/Pipelines hinweg darstellen. | FE + BE |

### Prio 3 – Komfort & Visualisierung
| # | Feature | Ausformuliert | Schicht |
|---|---|---|---|
| 3.1 | **BigQuery-Deeplink** | Link öffnet das Modell direkt im BQ-Console-Editor (ausführbarer Code). | FE (URL aus BE) |
| 3.2 | **Stage-Zonen (src/int/out)** | Optionale Darstellung mit klaren visuellen Zonen/Spalten pro Stage. | FE |
| 3.3 | **Mini-Map** | Window-in-window Übersicht (React Flow MiniMap), zeigt aktuelle Position im Graphen. | FE |
| 3.4 | **Area-Select & Verschieben** | Rechteck-Auswahl, um ganze Graph-Teile zu markieren/verschieben. | FE |
| 3.5 | **Execution Mode pro Modell** | Anzeige, in welchem Execution-/Run-Modus ein Modell läuft. | FE + BE |
| 3.6 | **Copy dbt run Command** | Button generiert `dbt run --select <model>` zum Kopieren. | FE |

### Prio 4 – Weiterführend
| # | Feature | Ausformuliert | Schicht |
|---|---|---|---|
| 4.1 | **VSCode Extension** | Lineage Explorer als Panel in VSCode. *Eigenes Projekt – nach Hackathon.* | – |
| 4.2 | **BQ-Kosten sichtbar** | Kosten/Bytes pro Modell anzeigen (INFORMATION_SCHEMA / Job-Metadaten). | BE (+ FE) |

---

## 5. Arbeitspakete (4 parallele Streams)

> **Reihenfolge:** Zuerst **gemeinsam** den API-Contract (Abschnitt 3.1) in ~30–45 Min fixieren und ein **Mock-manifest/catalog** bereitstellen. Danach entkoppeltes Arbeiten.

### 🟢 AP-0 · Kick-off (alle, ~45 Min, ganz am Anfang)
- API-Contract v0 final abstimmen und als `contract.md` / TS-Types + Pydantic-Models committen.
- Repo-Setup: `frontend/` (Vite+React+TS+React Flow), `backend/` (FastAPI), gemeinsames `fixtures/` mit echtem `manifest.json` + `catalog.json` einer PnC-Pipeline.
- Mock-Server bzw. statisches JSON, damit FE sofort loslegen kann.

---

### 📦 AP-1 · Backend: Daten-Loader & Core-API
**Fokus:** Backend · **Deckt ab:** 1.2, 1.3, 1.6, 1.5 (Daten), Grundlage für alles.

- Loader für `manifest.json` + `catalog.json` → internes Graph-Modell.
- Stage-Ableitung (src/int/out) aus Namens-Prefix/Pfad-Konvention.
- `GET /api/graph` (schlanke Nodes+Edges) und `GET /api/model/{id}` (Detail inkl. `compiled_code`, deps/dependents, materialization).
- Dependents aus den `depends_on`-Relationen invertieren.
- Unit-Tests gegen Fixture-Daten.

**Abhängigkeiten:** Nur Contract v0. Blockiert niemanden (FE nutzt Mock).

---

### 📦 AP-2 · Frontend: Graph-Canvas & Navigation
**Fokus:** Frontend · **Deckt ab:** 1.1, 1.4, 1.6 (Darstellung), 1.7, 1.8, 3.2, 3.3, 3.4.

- React-Flow-Setup, Custom Node (Stage-Farbe, Materialisierungs-Badge, grössere Schrift).
- Layout (dagre/elk) für gerichteten DAG, Zoom-to-fit, Pan/Zoom.
- **Focus Mode** (Highlight-Pfad + Rest ausblenden/abdunkeln).
- Multi-Selection + `+model+`-Logik (auf Graph-Daten angewandt).
- Mini-Map, Area-Select, optionale Stage-Zonen.

**Abhängigkeiten:** Contract v0 + Mock `graph`-JSON. Entkoppelt von AP-1.

---

### 📦 AP-3 · Frontend: Modell-Overlay & Suche
**Fokus:** Frontend · **Deckt ab:** 1.2 (Viz), 1.3 (Viz), 1.5 (UI), 2.1, 2.2, 3.1, 3.6.

- Sliding Side-Overlay: Code-Viewer (Syntax-Highlighting via Shiki/Prism + Copy), Deps/Dependents-Listen (klickbar → Graph).
- SearchBar mit Fuzzy-Search (Fuse.js clientseitig, oder `/api/search`).
- Schema-Tab (Spalten + Typen), Spalten-Suche-UI.
- BQ-Deeplink-Button, "Copy dbt run"-Button.

**Abhängigkeiten:** Contract v0 + Mock `model`-JSON. Koordination mit AP-2 nur bei Klick→Highlight-Events (gemeinsamer State, z.B. Zustand/Context früh definieren).

---

### 📦 AP-4 · Backend: Suche, Schema & Erweiterungen
**Fokus:** Backend · **Deckt ab:** 1.5 (Index), 2.1, 2.2, 2.4, 3.1 (URL), 3.5, 4.2.

- `GET /api/search` (Fuzzy, serverseitig – z.B. rapidfuzz) + `GET /api/search/columns`.
- Spalten aus `catalog.json` ins Modell-Detail mergen.
- Lineage across Pipelines: mehrere manifests laden & mergen.
- BQ-Deeplink-URL-Builder (project/dataset/table → Console-URL).
- (Stretch) Execution Mode & BQ-Kosten-Adapter (INFORMATION_SCHEMA).

**Abhängigkeiten:** Baut auf AP-1-Loader auf → leichte Reihenfolge-Kopplung. Lässt sich nach AP-1-Grundgerüst übernehmen; bis dahin an Search-Index + Schema-Merge auf Fixtures arbeiten.

---

## 6. Vorgeschlagener Zeitplan (1.5 Tage)

| Zeit | Alle / Querschnitt | AP-1/4 (BE) | AP-2/3 (FE) |
|---|---|---|---|
| **Tag 1 Vormittag** | AP-0: Contract + Setup + Fixtures | Loader + `/graph` | Canvas + Node-Rendering (Mock) |
| **Tag 1 Nachmittag** | — | `/model/{id}` + deps/dependents | Overlay + Code-Viewer, Focus Mode |
| **Tag 1 Abend/Check** | **Integration FE↔BE (echte API)** | Search-API | Suche-UI + Navigation |
| **Tag 2 Vormittag** | Schema/Spalten (2.1/2.2), Polish | Schema-Merge, Search-Columns | Schema-Tab, Mini-Map, Badges |
| **Tag 2 Mittag** | **Demo-Vorbereitung** (Stretch: 2.3/3.x nach Kapazität) | | |

---

## 7. Risiken & Empfehlungen
- **Column-Level Lineage (2.3)** ist der grösste Aufwand (SQL-Parsing mit sqlglot) – klar als **Stretch Goal** behandeln, nicht in den kritischen Pfad legen.
- **Graph-Performance:** Bei sehr grossen Pipelines React Flow mit Virtualisierung / nur Subgraph rendern. Früh mit echten Fixture-Grössen testen.
- **Shared Frontend State** (Selektion/Highlight) zwischen AP-2 und AP-3 früh definieren (ein zentraler Store, z.B. Zustand), um Merge-Konflikte zu vermeiden.
- **Contract-first:** Jede Contract-Änderung sofort im gemeinsamen `contract`-File spiegeln – das ist die einzige echte Kopplung zwischen den Teams.

---

## 8. Offene Punkte (vor Kick-off klären)
- [ ] Stage-Konvention: Wie werden src/int/out erkannt? (Namens-Prefix `src_/int_/out_`, Folder, dbt-Tag oder Layer-Config?)
- [ ] Welche konkrete PnC-Pipeline liefert das erste `manifest.json`/`catalog.json` als Fixture?
- [ ] BQ-Deeplink: Auf welche Console-URL/Projekt zeigen wir (exp vs. prd)?
- [ ] Multi-Select `+model+`: rein visuell (Selektion) oder auch als dbt-Selektor-String exportierbar?
