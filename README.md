# adhd-map

An explorable map of ADHD: symptoms, the triggers that make them worse, the
coping strategies and treatments that help, and the impacts they have on
daily life. Click a node to open it and reveal what it is connected to.

The site is plain static HTML and JavaScript, served straight from this
repository by GitHub Pages. There is no build step.

## How it works

The map is rendered with [Cytoscape.js](https://js.cytoscape.org/) and the
fcose layout. `index.html` and `app.js` are the page; `shared/` holds the
YAML loader, the expand and collapse state, the side panel, legend and
search, the language handling, and the stylesheet.

Browsing:

- Click a node: it becomes selected, its details and connections appear in
  the side panel, and its hidden neighbours unfold next to it.
- Click an open node again: the nodes it revealed fold away again.
- A dashed ring marks nodes that still have hidden neighbours.
- Chips in the side panel jump to that node, revealing it if needed.
- "Show the whole loop" reveals a vicious cycle in one go, and "Show what
  this reaches" reveals what a strategy does through its mechanisms.
- The search box jumps to any node by name or by an alias, so "RSD" finds
  rejection sensitivity and "ADHD paralysis" finds task initiation.
- Fit, Expand all and Reset live in the toolbar. Escape clears the selection.
- Options opens a box with sliders and toggles: how far inactive nodes fade,
  whether they keep their labels, label size, node spacing, layout animation,
  automatic framing of the opened node, relation names on highlighted links,
  and the two-hop reach highlight. Choices are stored in the browser.
- Hovering a node shows a popup with its name, kind and description. By
  default it speaks the same language as the map; "Popup language" in the
  options switches it to any other language, so the map can be read in one
  language and the popup in another. "Popup on hover" turns it off. The
  popup is suppressed once touch input is detected, since a tap already
  opens the side panel.

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
  drawn thick and curved, and the panel of any node in the cycle offers
  "Show the whole loop", which reveals the entire ring at once.
- `via: true` marks a chaining relation (the `produces` relation from a
  strategy to a mechanism). Selecting a node highlights its two-hop reach
  through such edges in a second tone, and the panel offers "Show what this
  reaches". This is how clicking exercise shows the effect spreading through
  its mechanisms to symptoms and impacts.

Node kinds are free-form: the current set is hub, cluster, symptom, trigger,
strategy, treatment, impact, condition (co-occurring conditions such as
anxiety), situation (real-life entry points such as "Chaotic home") and
mechanism ("How it works" nodes).

Two node fields keep the map's claims accurate, and both are validated:

- `scope` says how a node relates to an ADHD diagnosis: `core`, `associated`,
  `transdiagnostic`, `co-occurring` or `unspecified`. Every symptom node must
  state one. There is deliberately no default, because a node without a scope
  would read to a visitor as a diagnostic symptom.
- `evidence` says how well supported a strategy or treatment is: `guideline`,
  `research` or `reported`. It is required on every strategy and treatment,
  and the panel shows it with a note saying that support varies by use and
  that this is context rather than proof.

Two relations are easy to blur, so the structure file's header defines them:
`related_to` is a conceptual or within-person connection between experiences,
while `associated_with` is a documented population-level association with no
claim about cause in any individual. `leads_to` is shown to the reader as
"can lead to".

Nodes may also carry an `aliases` list in a language file, which feeds the
search box without appearing on the map.

Where good statistics exist, a node carries a `facts` list in the language
files. Each fact is translated text plus a key into the `sources` section of
the structure file, so a citation is written once and reused:

```yaml
# data/adhd-map.yaml
sources:
  who-depression:
    label: World Health Organization
    title: Depressive disorder (depression), fact sheet with 2023 data
    url: https://www.who.int/news-room/fact-sheets/detail/depression

# data/lang/en.yaml
nodes:
  depression:
    facts:
      - text: >-
          About 5.2% of adults worldwide had a depressive disorder in 2023.
        source: who-depression
```

The panel shows the facts with a link to the source. The validator refuses a
fact that cites an unknown source, and requires every language to carry the
same facts per node in the same order and citing the same sources, so a
translation cannot silently drop or re-attribute one. It also rejects an alias
that duplicates another alias or matches another node's label, which would
send a search to the wrong node.

A node can also cite a work it is described in, and the work that supports how
it is classified, using the same registry. Edges can cite sources too:

```yaml
nodes:
  - { id: medication, kind: treatment, evidence: guideline, sources: [nice-ng87, kooij-consensus] }
  - { id: if-then-plans, kind: strategy, evidence: research, references: [ramsay-rostain-2015] }
edges:
  - { id: adhd-anxiety, from: adhd, to: anxiety, relation: associated_with, sources: [hartman-2023] }
```

`references` is what describes a node, `sources` is what backs its
classification. The validator requires a source on every `guideline` node and
on every `associated_with` edge, since both make a claim a reader cannot check
otherwise. It also reports how many `research` nodes still name no source, so
that gap stays visible.

The panel then shows a "Described in" line, and the sources page lists every
node that cites each work, linking into the map. A `?node=<id>` parameter on
the map opens it with that node selected, which is how those links work.

Descriptions are written for this project. Where a technique comes from a
book, the node names and explains it in its own words and cites the book
rather than reproducing its text.

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

## Sources page

`sources.html` states that the map is educational rather than diagnostic,
explains the scope and evidence labels, and lists the sources. The list is
rendered from the `sources` section of the structure file, so the citations
behind the facts and the ones on the page cannot drift apart. Its text
comes from the language files like everything else, so it follows the reader's
language, and it carries its own review date.

## Running locally

The page fetches the YAML files, so it needs an HTTP server rather than a
`file://` URL. The bundled server disables caching so every reload shows
the current files:

```sh
./tools/serve.py 127.0.0.1 8080
```

Then open <http://127.0.0.1:8080/>. Pass a LAN address instead of
`127.0.0.1` to reach it from other devices.

`tools/smoke-test.mjs` drives the map in headless Chrome: it loads the
page, clicks real nodes, checks that neighbours appear and fold away,
reveals the rumination loop, checks the taxonomy badges and the evidence
context, searches by alias, switches the language to German, loads the
sources page, and writes screenshots to `tmp/`. It needs `google-chrome` and Node 22 or
newer:

```sh
node tools/smoke-test.mjs http://127.0.0.1:8080
```

## Deploying to GitHub Pages

The repository root is the site root, and `.nojekyll` keeps GitHub from
running Jekyll over it. In the repository settings, under Pages, choose
"Deploy from a branch", branch `main`, folder `/ (root)`. The site then
appears at `https://<user>.github.io/adhd-map/`.

The JavaScript libraries load from jsdelivr with pinned versions, so the
site works without any dependency installation.
