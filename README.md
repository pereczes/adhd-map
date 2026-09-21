# adhd-map

An explorable map of ADHD: symptoms, the triggers that make them worse, the
coping strategies and treatments that help, and the impacts they have on
daily life. Click a node to open it and reveal what it is connected to.

The site is plain static HTML and JavaScript, served straight from this
repository by GitHub Pages. There is no build step.

## Two prototypes

The project currently holds two renderings of the same data so the browsing
feel can be compared:

| Prototype | Directory | Library | Feel |
|-----------|-----------|---------|------|
| A | `cytoscape/` | [Cytoscape.js](https://js.cytoscape.org/) with the fcose layout | Tidy diagram; every expansion re-runs the layout and settles into a still picture |
| B | `force-graph/` | [force-graph](https://github.com/vasturiano/force-graph) | Live physics; nodes drift and settle in a running force simulation, and can be dragged and pinned |

Both read the same `data/adhd-map.yaml` and share the same expand and collapse
logic (`shared/explorer.js`), side panel and legend (`shared/panel.js`) and
styling (`shared/style.css`). Only the rendering code differs.

Browsing works the same way in both:

- Click a node: it becomes selected, its details and connections appear in
  the side panel, and its hidden neighbours unfold next to it.
- Click an open node again: the nodes it revealed fold away again.
- A dashed ring marks nodes that still have hidden neighbours.
- Chips in the side panel jump to that node, revealing it if needed.
- The search box jumps to any node by name.
- Fit, Expand all and Reset live in the toolbar. Escape clears the selection.

## Data

The content is split into structure and text so that translations never
touch the relationships:

| File | Holds |
|------|-------|
| `data/adhd-map.yaml` | Ids only: node kinds, relation types, nodes, edges. Colours and sizes live here too. |
| `data/languages.yaml` | The list of available languages and the default. |
| `data/lang/<code>.yaml` | All text for one language: labels, descriptions, edge notes, kind and relation names, interface strings. |

Currently available: English (`en`), German (`de`), Hungarian (`hu`) and
Romanian (`ro`). The language picker in the toolbar switches without
reloading and keeps the explored map. The choice is remembered in the
browser and carried in the URL as `?lang=de`, so links can be shared. A
first visit falls back to the browser language, then to the default.

Structure file:

```yaml
start: adhd
kinds:
  symptom:    { color: "#ef5350", size: 1 }
relations:
  helps_with: { color: "#66bb6a", directed: true }
nodes:
  - { id: body-doubling, kind: strategy }
edges:
  - { from: body-doubling, to: task-initiation, relation: helps_with }
  - { id: pomodoro-hyperfocus, from: pomodoro, to: hyperfocus, relation: helps_with }
```

An edge only needs an `id` when a language file attaches a note to it.

Two optional flags on a relation change how it is drawn and browsed:

- `loop: true` marks a vicious cycle (the `feeds` relation). Its edges are
  drawn thick and curved, force-graph animates particles along them
  permanently, and the panel of any node in the cycle offers "Show the
  whole loop", which reveals the entire ring at once.
- `via: true` marks a chaining relation (the `produces` relation from a
  strategy to a mechanism). Selecting a node highlights its two-hop reach
  through such edges in a second tone, and the panel offers "Show what this
  reaches". This is how clicking exercise shows the effect spreading through
  its mechanisms to symptoms and impacts.

Node kinds are free-form: the current set is hub, cluster, symptom, trigger,
strategy, treatment, impact, situation (real-life entry points such as
"Chaotic home") and mechanism ("How it works" nodes).

Language file:

```yaml
language: en
name: English
title: ADHD map
ui:
  reset: Reset
kinds:
  symptom: Symptom
relations:
  helps_with: { label: helps with, inverse: helped by }
nodes:
  body-doubling:
    label: Body doubling
    description: >-
      Working alongside another person whose presence makes starting easier.
edges:
  pomodoro-hyperfocus:
    note: >-
      The break alarm is an external interrupt for a session that would otherwise run for hours.
```

`inverse` is the heading used when a relation is read from the other end
(a symptom is "helped by" a strategy). Ids are lowercase with hyphens.

To add a language, copy `data/lang/en.yaml` to `data/lang/<code>.yaml`,
translate every value, and add a line to `data/languages.yaml`. Check the
result with:

```sh
./tools/validate-data.py
```

The validator reports unknown ids, kinds and relations, duplicates, nodes
without edges, nodes unreachable from the start node, and for every language
file any missing or unknown node, kind, relation, edge note or interface
string.

## Running locally

The pages fetch the YAML file, so they need an HTTP server rather than a
`file://` URL:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8765/>.

`tools/smoke-test.mjs` drives both prototypes in headless Chrome: it loads
each page, clicks real nodes, checks that neighbours appear and fold away,
switches the language to German, and writes screenshots to `tmp/`. It needs `google-chrome` and Node 22 or
newer:

```sh
node tools/smoke-test.mjs http://127.0.0.1:8765
```

## Deploying to GitHub Pages

The repository root is the site root, and `.nojekyll` keeps GitHub from
running Jekyll over it. In the repository settings, under Pages, choose
"Deploy from a branch", branch `main`, folder `/ (root)`. The site then
appears at `https://<user>.github.io/adhd-map/`.

The JavaScript libraries load from jsdelivr with pinned versions, so the
site works without any dependency installation.
