/* Side panel, legend and search box. Pure DOM, shared by both prototypes.
 *
 * createPanel(graph, explorer, {
 *   panel, legend, search, datalist   DOM elements
 *   onFocus(id)                        called when a node is chosen in the panel or search
 * })
 *
 * All strings come from graph.ui (the active language file). Call refresh()
 * after the language changes to redraw legend, search list and current view. */
(function () {
  'use strict';

  function createPanel(graph, explorer, options) {
    const panelElement = options.panel;
    let lastShownId = null;

    function text(key, fallback) {
      return (graph.ui && graph.ui[key]) || fallback;
    }

    function element(tag, className, content) {
      const node = document.createElement(tag);
      if (className) {
        node.className = className;
      }
      if (content !== undefined) {
        node.textContent = content;
      }
      return node;
    }

    function renderLegend() {
      const legend = options.legend;
      legend.replaceChildren();
      Object.entries(graph.kinds).forEach(([kindId, kind]) => {
        const row = element('div', 'legend-row');
        const swatch = element('span', 'swatch');
        swatch.style.background = kind.color;
        row.append(swatch, element('span', null, kind.label || kindId));
        legend.append(row);
      });
      legend.append(element('div', 'legend-gap'));
      Object.entries(graph.relations).forEach(([relationId, relation]) => {
        const row = element('div', 'legend-row');
        const line = element('span', 'line');
        line.style.borderTopColor = relation.color;
        line.style.borderTopStyle = relation.dashed ? 'dashed' : 'solid';
        row.append(line, element('span', null, relation.label || relationId));
        legend.append(row);
      });
    }

    function fillDatalist() {
      const datalist = options.datalist;
      datalist.replaceChildren();
      graph.nodes
        .slice()
        .sort((left, right) => left.label.localeCompare(right.label))
        .forEach((node) => {
          const option = document.createElement('option');
          option.value = node.label;
          datalist.append(option);
        });
    }

    function wireSearch() {
      options.search.addEventListener('change', () => {
        const wanted = options.search.value.trim().toLowerCase();
        if (!wanted) {
          return;
        }
        const match =
          graph.nodes.find((node) => node.label.toLowerCase() === wanted) ||
          graph.nodes.find((node) => node.label.toLowerCase().includes(wanted));
        if (match) {
          options.search.value = '';
          options.search.blur();
          options.onFocus(match.id);
        }
      });
    }

    function chipFor(neighbourId, note) {
      const neighbour = graph.node(neighbourId);
      const kind = graph.kindOf(neighbour);
      const item = element('li', 'chip-item');
      const chip = element('button', 'chip', neighbour.label);
      chip.type = 'button';
      chip.style.borderColor = kind.color;
      if (!explorer.isVisible(neighbourId)) {
        chip.classList.add('hidden-node');
        chip.title = text('reveal_chip', 'Not on the map yet. Click to reveal.');
      }
      chip.addEventListener('click', () => options.onFocus(neighbourId));
      item.append(chip);
      if (note) {
        item.append(element('div', 'note', note));
      }
      return item;
    }

    /* Group the node's edges by relation and direction, in the order the
     * relations are declared in the structure file. */
    function groupedEdges(id) {
      const groups = new Map();
      graph.edgesOf(id).forEach((edge) => {
        const relation = graph.relationOf(edge);
        const outgoing = edge.source === id;
        const heading = outgoing || !relation.directed ? relation.label : relation.inverse;
        const key = `${edge.relation}:${outgoing ? 'out' : 'in'}`;
        if (!groups.has(key)) {
          groups.set(key, { heading, relation, relationId: edge.relation, entries: [] });
        }
        groups.get(key).entries.push({
          neighbourId: outgoing ? edge.target : edge.source,
          note: edge.note,
        });
      });
      const order = Object.keys(graph.relations);
      return Array.from(groups.values()).sort(
        (left, right) => order.indexOf(left.relationId) - order.indexOf(right.relationId),
      );
    }

    function hintFor(id) {
      const hiddenCount = explorer.hiddenNeighbours(id).length;
      const revealedCount = explorer.revealedCount(id);
      const format = AdhdMapI18n.format;
      if (hiddenCount === 1) {
        return format(text('hidden_one', '1 connected node is not shown yet. Click the node again to reveal it.'), { count: 1 });
      }
      if (hiddenCount > 1) {
        return format(text('hidden_many', '{count} connected nodes are not shown yet. Click the node again to reveal them.'), { count: hiddenCount });
      }
      if (revealedCount === 1) {
        return format(text('fold_one', 'All connections are on the map. Click the node again to fold away the node it revealed.'), { count: 1 });
      }
      if (revealedCount > 1) {
        return format(text('fold_many', 'All connections are on the map. Click the node again to fold away the {count} nodes it revealed.'), { count: revealedCount });
      }
      return text('all_shown', 'All connections are on the map.');
    }

    function show(id) {
      lastShownId = id;
      const node = graph.node(id);
      const kind = graph.kindOf(node);
      panelElement.replaceChildren();

      const badge = element('span', 'kind-badge', kind.label || node.kind);
      badge.style.background = kind.color;
      panelElement.append(badge);
      panelElement.append(element('h2', null, node.label));
      panelElement.append(element('p', 'description', node.description));

      groupedEdges(id).forEach((group) => {
        const heading = element('h3', null, group.heading);
        const marker = element('span', 'heading-line');
        marker.style.background = group.relation.color;
        heading.prepend(marker);
        panelElement.append(heading);
        const list = element('ul', 'chip-list');
        group.entries.forEach((entry) => list.append(chipFor(entry.neighbourId, entry.note)));
        panelElement.append(list);
      });

      panelElement.append(element('p', 'hint', hintFor(id)));
    }

    function clear() {
      lastShownId = null;
      panelElement.replaceChildren();
      panelElement.append(element('h2', null, graph.title));
      panelElement.append(
        element(
          'p',
          'description',
          text(
            'intro',
            'Click a node to open it: its details appear here and its neighbours unfold on the map. Click an open node again to fold away what it revealed.',
          ),
        ),
      );
      panelElement.append(
        element('p', 'hint', text('intro_hint', 'Drag to pan, scroll to zoom, or use the search box to jump to any node.')),
      );
      panelElement.append(
        element(
          'p',
          'hint',
          AdhdMapI18n.format(text('counts', '{nodes} nodes, {links} links.'), {
            nodes: graph.nodes.length,
            links: graph.edges.length,
          }),
        ),
      );
    }

    /* Redraw everything from the current graph texts, keeping the view. */
    function refresh() {
      renderLegend();
      fillDatalist();
      if (lastShownId && explorer.isVisible(lastShownId)) {
        show(lastShownId);
      } else {
        clear();
      }
    }

    renderLegend();
    fillDatalist();
    wireSearch();
    clear();

    return { show, clear, refresh };
  }

  window.AdhdMapPanel = { createPanel };
})();
