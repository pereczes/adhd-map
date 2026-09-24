/* ADHD map: Cytoscape.js with the fcose layout.
 *
 * Every expansion adds the new nodes next to the node that was clicked, pins
 * that node in place, and re-runs fcose incrementally so the rest of the map
 * settles into a tidy diagram. */
(function () {
  'use strict';

  const DATA_URL = 'data/adhd-map.yaml';
  const LANGUAGES_URL = 'data/languages.yaml';
  const BASE_NODE_SIZE = 26;
  const SIZE_STEP = 14;
  const SPAWN_RADIUS = 40;
  const LAYOUT_ANIMATION_MS = 650;
  const SPACING_RELAYOUT_DELAY_MS = 350;
  const POPUP_DELAY_MS = 280;
  const POPUP_OFFSET = 16;

  /* User-adjustable settings, shown in the options box and kept in the browser. */
  const OPTION_DEFINITIONS = [
    { key: 'fade', type: 'range', labelKey: 'option_fade', defaultValue: 4, min: 0, max: 100 },
    { key: 'inactiveLabels', type: 'checkbox', labelKey: 'option_inactive_labels', defaultValue: false },
    { key: 'labelSize', type: 'range', labelKey: 'option_label_size', defaultValue: 11, min: 8, max: 18 },
    { key: 'spacing', type: 'range', labelKey: 'option_spacing', defaultValue: 110, min: 60, max: 220, step: 10 },
    { key: 'animate', type: 'checkbox', labelKey: 'option_animate', defaultValue: true },
    { key: 'autoFrame', type: 'checkbox', labelKey: 'option_auto_frame', defaultValue: true },
    { key: 'relationLabels', type: 'checkbox', labelKey: 'option_relation_labels', defaultValue: false },
    { key: 'reach', type: 'checkbox', labelKey: 'option_reach', defaultValue: true },
    { key: 'popup', type: 'checkbox', labelKey: 'option_popup', defaultValue: true },
  ];

  /* Appended once the language list is known: which language the hover popup
   * speaks. 'same' follows the language chosen in the toolbar. */
  function translationOption(languageIndex) {
    return {
      key: 'translation',
      type: 'select',
      labelKey: 'option_translation',
      defaultValue: 'same',
      choices: (ui) =>
        [{ value: 'same', label: ui.translation_same || 'Same as map' }].concat(
          languageIndex.languages.map((language) => ({ value: language.code, label: language.name })),
        ),
    };
  }
  const VIEW_ANIMATION_MS = 450;

  async function main() {
    cytoscape.use(cytoscapeFcose);

    const languageIndex = await AdhdMapI18n.loadIndex(LANGUAGES_URL);
    const initialCode = AdhdMapI18n.pickLanguage(languageIndex);
    let currentCode = initialCode;
    const graph = await AdhdMapData.loadGraph(DATA_URL, languageFileUrl(languageIndex, initialCode));
    AdhdMapI18n.applyUiStrings(graph.ui, initialCode);
    const explorer = AdhdMapExplorer.createExplorer(graph);
    const graphElement = document.getElementById('graph');
    let selectedId = null;
    let activeLayout = null;
    let spacingTimer = null;
    let popupTimer = null;
    let translation = null;
    let touchInput = false;
    const options = AdhdMapOptions.createOptions(
      OPTION_DEFINITIONS.concat(translationOption(languageIndex)),
      'adhd-map-options',
    );

    const cy = cytoscape({
      container: graphElement,
      style: buildStyle(options),
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
          relationLabel: relation.label,
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

    function runLayout(layoutOptions) {
      if (activeLayout) {
        activeLayout.stop();
      }
      let fixedNodeConstraint;
      if (layoutOptions.fixedId) {
        const fixedNode = cy.getElementById(layoutOptions.fixedId);
        if (fixedNode.nonempty()) {
          const position = fixedNode.position();
          fixedNodeConstraint = [{ nodeId: layoutOptions.fixedId, position: { x: position.x, y: position.y } }];
        }
      }
      const layout = cy.layout({
        name: 'fcose',
        quality: 'default',
        randomize: Boolean(layoutOptions.randomize),
        animate: options.get('animate'),
        animationDuration: LAYOUT_ANIMATION_MS,
        animationEasing: 'ease-out',
        fit: false,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 80 * options.get('spacing'),
        idealEdgeLength: () => options.get('spacing'),
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
      if (options.get('reach')) {
        const reach = explorer.reachOf(id);
        [...reach.via, ...reach.targets].forEach((reachId) => {
          cy.getElementById(reachId).removeClass('dimmed').addClass('reach');
        });
        reach.edges.forEach((edge) => {
          cy.getElementById(edge.id).removeClass('dimmed').addClass('reach');
        });
      }
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
      if (options.get('autoFrame')) {
        centerOn(id);
      }
      await runLayout({ fixedId: id });
      if (selectedId === id && options.get('autoFrame')) {
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
      currentCode = code;
      await graph.loadLanguage(languageFileUrl(languageIndex, code));
      AdhdMapI18n.remember(code);
      AdhdMapI18n.applyUiStrings(graph.ui, code);
      cy.nodes().forEach((node) => node.data('label', graph.node(node.id()).label));
      cy.edges().forEach((edge) => edge.data('relationLabel', graph.relations[edge.data('relation')].label));
      options.render(optionsElement, graph.ui);
      await applyTranslationOption();
      panel.refresh();
    });

    /* Hover popup: the same node in a second language. */
    const popupElement = document.getElementById('popup');

    function hidePopup() {
      clearTimeout(popupTimer);
      popupElement.hidden = true;
    }

    /* The popup speaks either the chosen second language or, by default, the
     * same language as the map. */
    function popupTextFor(id) {
      const node = graph.node(id);
      if (translation) {
        const text = translation.node(id);
        return text
          ? {
              language: translation.name,
              label: text.label,
              kind: translation.kind(node.kind),
              scope: translation.scope(node.scope),
              description: text.description,
            }
          : null;
      }
      const current = languageIndex.languages.find((language) => language.code === currentCode);
      return {
        language: current ? current.name : '',
        label: node.label,
        kind: graph.kindOf(node).label,
        scope: graph.scopeLabel(node),
        description: node.description,
      };
    }

    function showPopup(id, renderedPosition) {
      if (touchInput || !options.get('popup')) {
        return;
      }
      const text = popupTextFor(id);
      if (!text) {
        return;
      }
      popupElement.replaceChildren();

      const language = document.createElement('div');
      language.className = 'popup-language';
      language.textContent = text.language;
      const label = document.createElement('div');
      label.className = 'popup-label';
      label.textContent = text.label;
      const kind = document.createElement('div');
      kind.className = 'popup-kind';
      kind.textContent = text.scope ? `${text.kind} · ${text.scope}` : text.kind;
      const description = document.createElement('div');
      description.className = 'popup-description';
      description.textContent = text.description || '';
      popupElement.append(language, label, kind, description);

      popupElement.hidden = false;
      const width = popupElement.offsetWidth;
      const height = popupElement.offsetHeight;
      const overflowsRight = renderedPosition.x + POPUP_OFFSET + width > graphElement.clientWidth;
      const overflowsBottom = renderedPosition.y + POPUP_OFFSET + height > graphElement.clientHeight;
      popupElement.style.left = `${Math.max(4, renderedPosition.x + (overflowsRight ? -width - POPUP_OFFSET : POPUP_OFFSET))}px`;
      popupElement.style.top = `${Math.max(4, renderedPosition.y + (overflowsBottom ? -height - POPUP_OFFSET : POPUP_OFFSET))}px`;
    }

    async function applyTranslationOption() {
      let code = options.get('translation');
      hidePopup();
      /* A value stored by an older version of the options box may name a
       * language that no longer exists. Fall back rather than fetch nothing. */
      if (code !== 'same' && !languageIndex.languages.some((language) => language.code === code)) {
        code = 'same';
        options.set('translation', code);
        return;
      }
      if (code === 'same' || code === currentCode) {
        translation = null;
        return;
      }
      translation = await AdhdMapI18n.loadTranslation(languageFileUrl(languageIndex, code));
    }

    /* On touch input a tap already opens the panel, and browsers fire a
     * synthetic mouseover that would leave the popup stuck on screen. Watch
     * for real touches rather than asking the media query, so hybrid laptops
     * keep working with the mouse. */
    graphElement.addEventListener(
      'touchstart',
      () => {
        touchInput = true;
        hidePopup();
      },
      { passive: true },
    );
    cy.on('mouseover', 'node', (event) => {
      const id = event.target.id();
      clearTimeout(popupTimer);
      popupTimer = setTimeout(() => showPopup(id, event.target.renderedPosition()), POPUP_DELAY_MS);
    });
    cy.on('mouseout', 'node', hidePopup);
    cy.on('tap grab pan zoom', hidePopup);

    /* Options box. */
    const optionsElement = document.getElementById('options');
    const optionsToggle = document.getElementById('options-toggle');
    optionsToggle.addEventListener('click', () => {
      optionsElement.hidden = !optionsElement.hidden;
    });
    options.render(optionsElement, graph.ui);
    options.onChange((key) => {
      if (key === 'translation' || key === null) {
        applyTranslationOption();
      }
      if (key === 'translation') {
        return;
      }
      if (key === 'spacing') {
        clearTimeout(spacingTimer);
        spacingTimer = setTimeout(() => runLayout({ fixedId: selectedId }), SPACING_RELAYOUT_DELAY_MS);
        return;
      }
      cy.style().fromJson(buildStyle(options)).update();
      if (key === 'reach' && selectedId) {
        select(selectedId);
      }
      if (key === null) {
        runLayout({ fixedId: selectedId });
      }
    });

    document.getElementById('reset').addEventListener('click', reset);
    document.getElementById('expand-all').addEventListener('click', expandAll);
    document.getElementById('fit').addEventListener('click', fitAll);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!optionsElement.hidden) {
          optionsElement.hidden = true;
          return;
        }
        clearSelection();
      }
    });

    /* Small hook for tools/smoke-test.mjs: page coordinates of a node. */
    window.adhdMapDebug = {
      graph,
      explorer,
      nodeScreenPosition(id) {
        const rendered = cy.getElementById(id).renderedPosition();
        const rect = graphElement.getBoundingClientRect();
        return { x: rect.left + rendered.x, y: rect.top + rendered.y };
      },
    };

    await applyTranslationOption();
    await reset();

    /* A ?node= link, such as one from the sources page, opens the map there. */
    const requested = new URLSearchParams(window.location.search).get('node');
    if (requested && graph.node(requested)) {
      focusNode(requested);
    }
  }

  function languageFileUrl(index, code) {
    return `data/${AdhdMapI18n.fileFor(index, code)}`;
  }

  function buildStyle(options) {
    const fade = options.get('fade') / 100;
    const relationLabelStyle = options.get('relationLabels')
      ? {
          label: 'data(relationLabel)',
          'font-size': Math.max(8, options.get('labelSize') - 2),
          color: '#9aa5b1',
          'text-rotation': 'autorotate',
          'text-background-color': '#101418',
          'text-background-opacity': 0.85,
          'text-background-padding': 2,
        }
      : { label: '' };
    return [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          width: 'data(size)',
          height: 'data(size)',
          label: 'data(label)',
          color: '#e6ebef',
          'font-size': options.get('labelSize'),
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
        style: { width: 2.5, opacity: 1, ...relationLabelStyle },
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
        selector: 'node.dimmed',
        style: {
          'background-opacity': fade,
          'text-opacity': options.get('inactiveLabels') ? Math.max(0.3, fade) : 0,
          'border-opacity': 0,
        },
      },
      {
        selector: 'edge.dimmed',
        style: { opacity: fade / 2 },
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
