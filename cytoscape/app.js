/* Prototype A: Cytoscape.js with the fcose layout.
 *
 * Every expansion adds the new nodes next to the node that was clicked, pins
 * that node in place, and re-runs fcose incrementally so the rest of the map
 * settles into a tidy diagram. */
(function () {
  'use strict';

  const DATA_URL = '../data/adhd-map.yaml';
  const LANGUAGES_URL = '../data/languages.yaml';
  const BASE_NODE_SIZE = 26;
  const SIZE_STEP = 14;
  const SPAWN_RADIUS = 40;
  const LAYOUT_ANIMATION_MS = 650;
  const VIEW_ANIMATION_MS = 450;

  async function main() {
    cytoscape.use(cytoscapeFcose);

    const languageIndex = await AdhdMapI18n.loadIndex(LANGUAGES_URL);
    const initialCode = AdhdMapI18n.pickLanguage(languageIndex);
    const graph = await AdhdMapData.loadGraph(DATA_URL, languageFileUrl(languageIndex, initialCode));
    AdhdMapI18n.applyUiStrings(graph.ui, initialCode);
    const explorer = AdhdMapExplorer.createExplorer(graph);
    const graphElement = document.getElementById('graph');
    let selectedId = null;
    let activeLayout = null;

    const cy = cytoscape({
      container: graphElement,
      style: buildStyle(),
      minZoom: 0.15,
      maxZoom: 3,
      boxSelectionEnabled: false,
      autounselectify: true,
    });

    const panel = AdhdMapPanel.createPanel(graph, explorer, {
      panel: document.getElementById('panel'),
      legend: document.getElementById('legend'),
      search: document.getElementById('search'),
      datalist: document.getElementById('node-list'),
      onFocus: focusNode,
      onShowLoop: (id) => openNode(id, explorer.expandLoop(id)),
      onShowReach: (id) => openNode(id, explorer.expandReach(id)),
    });

    function nodeElement(node, position) {
      const kind = graph.kindOf(node);
      return {
        group: 'nodes',
        data: {
          id: node.id,
          label: node.label,
          kind: node.kind,
          color: kind.color,
          size: BASE_NODE_SIZE + SIZE_STEP * ((kind.size || 1) - 1),
        },
        position,
      };
    }

    function edgeElement(edge) {
      const relation = graph.relationOf(edge);
      const classes = [];
      if (relation.directed) {
        classes.push('directed');
      }
      if (relation.dashed) {
        classes.push('dashed');
      }
      if (relation.loop) {
        classes.push('loop');
      }
      return {
        group: 'edges',
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          color: relation.color,
        },
        classes: classes.join(' '),
      };
    }

    function currentPositions() {
      const placed = new Map();
      cy.nodes().forEach((node) => {
        const position = node.position();
        placed.set(node.id(), { x: position.x, y: position.y });
      });
      return placed;
    }

    function viewportCenter() {
      const extent = cy.extent();
      return { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
    }

    /* New nodes start next to an already placed neighbour so they visibly
     * unfold from it instead of flying in from a random corner. */
    function spawnPosition(id, placed, fallback) {
      const anchorId = graph.neighboursOf(id).find((neighbourId) => placed.has(neighbourId));
      const anchor = anchorId ? placed.get(anchorId) : fallback;
      const angle = Math.random() * Math.PI * 2;
      return {
        x: anchor.x + SPAWN_RADIUS * Math.cos(angle),
        y: anchor.y + SPAWN_RADIUS * Math.sin(angle),
      };
    }

    function applyChange(change, anchorId) {
      change.removed.forEach((id) => cy.getElementById(id).remove());

      const placed = currentPositions();
      const fallback = anchorId && placed.has(anchorId) ? placed.get(anchorId) : viewportCenter();
      const newNodes = change.added.map((id) => {
        const position = spawnPosition(id, placed, fallback);
        placed.set(id, position);
        return nodeElement(graph.node(id), position);
      });
      cy.add(newNodes);

      const newEdges = explorer
        .edgesTouching(change.added)
        .filter((edge) => cy.getElementById(edge.id).empty())
        .map(edgeElement);
      cy.add(newEdges);

      cy.nodes().forEach((node) => {
        node.toggleClass('expandable', explorer.hasHiddenNeighbours(node.id()));
      });
    }

    function runLayout(options) {
      if (activeLayout) {
        activeLayout.stop();
      }
      let fixedNodeConstraint;
      if (options.fixedId) {
        const fixedNode = cy.getElementById(options.fixedId);
        if (fixedNode.nonempty()) {
          const position = fixedNode.position();
          fixedNodeConstraint = [{ nodeId: options.fixedId, position: { x: position.x, y: position.y } }];
        }
      }
      const layout = cy.layout({
        name: 'fcose',
        quality: 'default',
        randomize: Boolean(options.randomize),
        animate: true,
        animationDuration: LAYOUT_ANIMATION_MS,
        animationEasing: 'ease-out',
        fit: false,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 9000,
        idealEdgeLength: () => 110,
        edgeElasticity: () => 0.25,
        gravity: 0.2,
        gravityRange: 3.8,
        numIter: 2500,
        fixedNodeConstraint,
      });
      activeLayout = layout;
      const finished = layout.promiseOn('layoutstop');
      layout.run();
      return finished;
    }

    function select(id) {
      selectedId = id;
      const node = cy.getElementById(id);
      cy.elements().removeClass('dimmed selected highlighted reach');
      node.addClass('selected');
      const neighbourhood = node.closedNeighborhood();
      neighbourhood.edges().addClass('highlighted');
      cy.elements().difference(neighbourhood).addClass('dimmed');

      /* Ripple: what this node reaches through mechanisms, in a second tone. */
      const reach = explorer.reachOf(id);
      [...reach.via, ...reach.targets].forEach((reachId) => {
        cy.getElementById(reachId).removeClass('dimmed').addClass('reach');
      });
      reach.edges.forEach((edge) => {
        cy.getElementById(edge.id).removeClass('dimmed').addClass('reach');
      });
      panel.show(id);
    }

    function clearSelection() {
      selectedId = null;
      cy.elements().removeClass('dimmed selected highlighted reach');
      panel.clear();
    }

    function centerOn(id) {
      const node = cy.getElementById(id);
      if (node.nonempty()) {
        cy.animate({ center: { eles: node } }, { duration: VIEW_ANIMATION_MS, easing: 'ease-out' });
      }
    }

    /* Zoom out just enough for the node and its neighbours to fit on screen.
     * Never zooms in, so the map does not lurch on small expansions. */
    function frameNeighbourhood(id) {
      const node = cy.getElementById(id);
      if (node.empty()) {
        return;
      }
      const box = node.closedNeighborhood().boundingBox({ includeLabels: true });
      const width = cy.width();
      const height = cy.height();
      const padding = 60;
      const fitZoom = Math.min((width - 2 * padding) / box.w, (height - 2 * padding) / box.h);
      const zoom = Math.max(cy.minZoom(), Math.min(cy.zoom(), fitZoom));
      const centerX = (box.x1 + box.x2) / 2;
      const centerY = (box.y1 + box.y2) / 2;
      cy.animate(
        { zoom, pan: { x: width / 2 - zoom * centerX, y: height / 2 - zoom * centerY } },
        { duration: VIEW_ANIMATION_MS, easing: 'ease-out' },
      );
    }

    function fitAll() {
      cy.animate(
        { fit: { eles: cy.elements(), padding: 50 } },
        { duration: VIEW_ANIMATION_MS, easing: 'ease-out' },
      );
    }

    async function openNode(id, change) {
      applyChange(change, id);
      select(id);
      centerOn(id);
      await runLayout({ fixedId: id });
      if (selectedId === id) {
        frameNeighbourhood(id);
      }
    }

    function focusNode(id) {
      openNode(id, explorer.expand(id));
    }

    async function reset() {
      cy.elements().remove();
      clearSelection();
      applyChange(explorer.reset(), null);
      await runLayout({ randomize: true, fixedId: graph.start });
      fitAll();
    }

    async function expandAll() {
      applyChange(explorer.expandAll(), selectedId);
      if (selectedId) {
        select(selectedId);
      }
      await runLayout({ fixedId: selectedId });
      fitAll();
    }

    cy.on('tap', 'node', (event) => {
      const id = event.target.id();
      openNode(id, explorer.toggle(id));
    });
    cy.on('tap', (event) => {
      if (event.target === cy) {
        clearSelection();
      }
    });

    const languageSelect = document.getElementById('language');
    AdhdMapI18n.fillLanguageSelect(languageSelect, languageIndex, initialCode);
    languageSelect.addEventListener('change', async () => {
      const code = languageSelect.value;
      await graph.loadLanguage(languageFileUrl(languageIndex, code));
      AdhdMapI18n.remember(code);
      AdhdMapI18n.applyUiStrings(graph.ui, code);
      cy.nodes().forEach((node) => node.data('label', graph.node(node.id()).label));
      panel.refresh();
    });

    document.getElementById('reset').addEventListener('click', reset);
    document.getElementById('expand-all').addEventListener('click', expandAll);
    document.getElementById('fit').addEventListener('click', fitAll);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        clearSelection();
      }
    });

    /* Small hook for tools/smoke-test.mjs: page coordinates of a node. */
    window.adhdMapDebug = {
      explorer,
      nodeScreenPosition(id) {
        const rendered = cy.getElementById(id).renderedPosition();
        const rect = graphElement.getBoundingClientRect();
        return { x: rect.left + rendered.x, y: rect.top + rendered.y };
      },
    };

    await reset();
  }

  function languageFileUrl(index, code) {
    return `../data/${AdhdMapI18n.fileFor(index, code)}`;
  }

  function buildStyle() {
    return [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          width: 'data(size)',
          height: 'data(size)',
          label: 'data(label)',
          color: '#e6ebef',
          'font-size': 11,
          'font-family': 'system-ui, sans-serif',
          'text-wrap': 'wrap',
          'text-max-width': 100,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 6,
          'text-outline-color': '#101418',
          'text-outline-width': 2,
          'overlay-opacity': 0,
          'transition-property': 'opacity',
          'transition-duration': '0.25s',
        },
      },
      {
        selector: 'node.expandable',
        style: {
          'border-width': 2,
          'border-style': 'dashed',
          'border-color': '#e6ebef',
          'border-opacity': 0.55,
        },
      },
      {
        selector: 'node.selected',
        style: {
          'border-width': 4,
          'border-style': 'solid',
          'border-color': '#ffffff',
          'border-opacity': 1,
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'line-color': 'data(color)',
          'curve-style': 'bezier',
          'target-arrow-shape': 'none',
          'arrow-scale': 0.8,
          opacity: 0.75,
          'transition-property': 'opacity',
          'transition-duration': '0.25s',
        },
      },
      {
        selector: 'edge.directed',
        style: {
          'target-arrow-shape': 'triangle',
          'target-arrow-color': 'data(color)',
        },
      },
      {
        selector: 'edge.dashed',
        style: { 'line-style': 'dashed' },
      },
      {
        selector: 'edge.loop',
        style: {
          width: 3.5,
          opacity: 0.95,
          'curve-style': 'unbundled-bezier',
          'control-point-distances': [40],
          'control-point-weights': [0.5],
          'arrow-scale': 1.1,
        },
      },
      {
        selector: 'edge.highlighted',
        style: { width: 2.5, opacity: 1 },
      },
      {
        selector: 'node.reach',
        style: { opacity: 0.85 },
      },
      {
        selector: 'edge.reach',
        style: { width: 2, opacity: 0.85 },
      },
      {
        selector: '.dimmed',
        style: { opacity: 0.18 },
      },
    ];
  }

  main().catch((error) => {
    const box = document.createElement('div');
    box.className = 'error';
    box.textContent = error.message;
    document.getElementById('graph').append(box);
    console.error(error);
  });
})();
