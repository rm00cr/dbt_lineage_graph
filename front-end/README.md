# Frontend — dbt Lineage Explorer

React 18 + TypeScript + Vite + [React Flow](https://reactflow.dev) (`@xyflow/react` v12).

```bash
export PATH="$HOME/.local/node/bin:$PATH"   # no system-wide node on this machine
npm install
npm run dev        # http://localhost:5173, proxies /api -> 127.0.0.1:8000
npm test           # vitest
npm run build      # type-check + production bundle into dist/
```

Without a backend the app loads bundled mock data and shows a banner, so the UI can be
developed on its own.

## Configuration

| Variable | Effect |
|---|---|
| `VITE_API_BASE_URL` | absolute API origin; empty (default) uses the dev-server proxy |
| `VITE_API_PROXY_TARGET` | where the dev server proxies `/api` (default `http://127.0.0.1:8000`) |

## Layout

```
src/
├── api/
│   ├── types.ts        contract v0 types (mirror of back-end/app/schemas.py)
│   ├── client.ts       fetch wrapper
│   └── mock.ts         offline fallback graph + model detail
├── graph/
│   ├── layout.ts       dagre DAG layout + stage-lane layout
│   ├── selectors.ts    traversal, lineage closure, dbt selector syntax (+model+)
│   └── selectors.test.ts
├── store/
│   └── useExplorerStore.ts   the single shared store (graph, selection, focus, overlay)
├── components/
│   ├── GraphCanvas.tsx       React Flow canvas, focus mode, area select, mini-map, lanes
│   ├── nodes/ModelNode.tsx   custom node: stage colour, materialization badge, big label
│   ├── Toolbar.tsx           layout / focus / filters / `+model+` selector
│   ├── SearchBar.tsx         fuzzy model search + column search
│   ├── ModelOverlay.tsx      sliding detail panel with 4 tabs
│   ├── CodeViewer.tsx        compiled / raw SQL, highlighting, copy, download
│   ├── SchemaTable.tsx       columns, types, descriptions, filter
│   ├── Legend.tsx            stage + materialization legend
│   └── visual.tsx            colours, icons, formatters
├── hooks/
│   ├── useKeyboardShortcuts.ts
│   └── useUrlSync.ts         shareable `?model=…&tab=…&layout=…&focus=…&select=…`
└── styles/global.css         design tokens and all component styles
```

## Conventions worth keeping

- **One store.** Canvas, overlay, search and toolbar all read and write
  `useExplorerStore`. Nothing holds a second copy of the selection.
- **Controlled React Flow.** Nodes are rebuilt from store state on every render, so node
  objects must carry explicit `width`/`height` — React Flow never writes measurements back
  into controlled nodes, and the mini-map needs the dimensions.
- **Contract first.** Changing a payload means changing `api/types.ts`, `app/schemas.py`
  and `contract.md` in the same commit.

## Styling

Plain CSS with custom properties in `styles/global.css` — no UI framework, no build step
beyond Vite. Stage colour is exposed as `--stage-color` on node and panel roots, so a
component only needs that one variable to match the canvas.
