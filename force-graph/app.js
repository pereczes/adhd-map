/* Prototype B: force-graph (canvas, live d3-force simulation).
 *
 * Nodes are drawn by hand on the canvas so the look matches prototype A.
 * Expanding a node spawns its neighbours next to it and lets the physics
 * settle them; the selected node is held in place while it is open. */
(function () {
  'use strict';

  const DATA_URL = '../data/adhd-map.yaml';
  const LANGUAGES_URL = '../data/languages.yaml';
  const BASE_RADIUS = 7;
  const RADIUS_STEP = 4;
  const SPAWN_RADIUS = 18;
  const LABEL_MAX_CHARS = 18;
  const LABEL_MIN_SCALE = 0.45;
  const VIEW_ANIMATION_MS = 500;
  const FRAME_DELAY_MS = 1100;

  async function main() {
    const languageIndex = await AdhdMapI18n.loadIndex(LANGUAGES_URL);
    const initialCode = AdhdMapI18n.pickLanguage(languageIndex);
    const graph = await AdhdMapData.loadGraph(DATA_URL, languageFileUrl(languageIndex, initialCode));
    AdhdMapI18n.applyUiStrings(graph.ui, initialCode);
    const explorer = AdhdMapExplorer.createExplorer(graph);
    const container = document.getElementById('graph');

    const nodeObjects = new Map();
    const linkObjects = new Map();
    const expandable = new Set();
    const labelCache = new Map();
    let selectedId = null;
    let neighbourIds = new Set();
    let hoveredId = null;
    let fitWhenSettled = false;
    let frameTimer = null;

    const panel = AdhdMapPanel.createPanel(graph, explorer, {
      panel: document.getElementById('panel'),
      legend: document.getElementById('legend'),
      search: document.getElementById('search'),
      datalist: document.getElementById('node-list'),
      onFocus: focusNode,
    });

    const forceGraph = ForceGraph()(container)
      .width(container.clientWidth)
      .height(container.clientHeight)
      .backgroundColor('#101418')
      .nodeId('id')
      .nodeLabel((node) => graph.kindOf(node).label)
      .nodeCanvasObjectMode(() => 'replace')
      .nodeCanvasObject(drawNode)
      .nodePointerAreaPaint(paintPointerArea)
      .linkColor(linkColor)
      .linkWidth((link) => (touchesSelection(link) ? 2 : 1))
      .linkLineDash((link) => (graph.relations[link.relation].dashed ? [3, 3] : null))
      .linkDirectionalArrowLength((link) => (graph.relations[link.relation].directed ? 5 : 0))
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalParticles((link) => (touchesSelection(link) ? 2 : 0))
      .linkDirectionalParticleWidth(2.5)
      .linkDirectionalParticleColor((link) => graph.relations[link.relation].color)
      .onNodeClick((node) => openNode(node.id, explorer.toggle(node.id)))
      .onNodeHover((node) => {
        hoveredId = node ? node.id : null;
        container.style.cursor = node ? 'pointer' : '';
      })
      .onBackgroundClick(clearSelection)
      .onNodeDragEnd((node) => {
        node.fx = node.x;
        node.fy = node.y;
        node.pinned = true;
      })
      .onEngineStop(() => {
        if (fitWhenSettled) {
          fitWhenSettled = false;
          forceGraph.zoomToFit(VIEW_ANIMATION_MS, 70);
        }
      })
      .d3VelocityDecay(0.35)
      .cooldownTime(3500);

    forceGraph.d3Force('charge').strength(-220).distanceMax(450);
    forceGraph
      .d3Force('link')
      .distance((link) => 40 + 6 * (radiusOf(endpointNode(link.source)) + radiusOf(endpointNode(link.target))));
    const centerForce = forceGraph.d3Force('center');
    if (centerForce && typeof centerForce.strength === 'function') {
      centerForce.strength(0.08);
    }

    new ResizeObserver(() => {
      forceGraph.width(container.clientWidth).height(container.clientHeight);
    }).observe(container);

    function radiusOf(node) {
      return BASE_RADIUS + RADIUS_STEP * ((graph.kindOf(node).size || 1) - 1);
    }

    function endpointNode(endpoint) {
      return typeof endpoint === 'object' ? endpoint : nodeObjects.get(endpoint);
    }

    function endpointId(endpoint) {
      return typeof endpoint === 'object' ? endpoint.id : endpoint;
    }

    function touchesSelection(link) {
      if (!selectedId) {
        return false;
      }
      return endpointId(link.source) === selectedId || endpointId(link.target) === selectedId;
    }

    function isDimmed(id) {
      return selectedId !== null && id !== selectedId && !neighbourIds.has(id);
    }

    function withAlpha(hexColor, alpha) {
      const red = parseInt(hexColor.slice(1, 3), 16);
      const green = parseInt(hexColor.slice(3, 5), 16);
      const blue = parseInt(hexColor.slice(5, 7), 16);
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }

    function linkColor(link) {
      const color = graph.relations[link.relation].color;
      if (!selectedId) {
        return withAlpha(color, 0.75);
      }
      return touchesSelection(link) ? color : withAlpha(color, 0.12);
    }

    function wrapLabel(label) {
      if (!labelCache.has(label)) {
        const lines = [];
        let current = '';
        label.split(' ').forEach((word) => {
          const candidate = current ? `${current} ${word}` : word;
          if (candidate.length > LABEL_MAX_CHARS && current) {
            lines.push(current);
            current = word;
          } else {
            current = candidate;
          }
        });
        if (current) {
          lines.push(current);
        }
        labelCache.set(label, lines);
      }
      return labelCache.get(label);
    }

    function drawRing(canvasContext, node, radius, strokeStyle, lineWidth, dash) {
      canvasContext.beginPath();
      canvasContext.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      canvasContext.setLineDash(dash || []);
      canvasContext.strokeStyle = strokeStyle;
      canvasContext.lineWidth = lineWidth;
      canvasContext.stroke();
      canvasContext.setLineDash([]);
    }

    function drawNode(node, canvasContext, globalScale) {
      const radius = radiusOf(node);
      const kind = graph.kindOf(node);
      const dimmed = isDimmed(node.id);
      const emphasised = node.id === selectedId || node.id === hoveredId || neighbourIds.has(node.id);
      const pixel = 1 / globalScale;

      canvasContext.save();
      canvasContext.globalAlpha = dimmed ? 0.2 : 1;

      canvasContext.beginPath();
      canvasContext.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      canvasContext.fillStyle = kind.color;
      canvasContext.fill();

      if (node.id === selectedId) {
        drawRing(canvasContext, node, radius + 2 * pixel, '#ffffff', 2.5 * pixel);
      } else if (expandable.has(node.id)) {
        drawRing(canvasContext, node, radius + 2.5 * pixel, 'rgba(230, 235, 239, 0.6)', 1.2 * pixel, [3 * pixel, 3 * pixel]);
      }
      if (node.id === hoveredId && node.id !== selectedId) {
        drawRing(canvasContext, node, radius + 4.5 * pixel, 'rgba(255, 255, 255, 0.5)', 1.2 * pixel);
      }

      if (globalScale >= LABEL_MIN_SCALE || emphasised) {
        const fontSize = 11 * pixel;
        canvasContext.font = `${fontSize}px system-ui, sans-serif`;
        canvasContext.textAlign = 'center';
        canvasContext.textBaseline = 'top';
        canvasContext.lineJoin = 'round';
        canvasContext.lineWidth = 3 * pixel;
        canvasContext.strokeStyle = '#101418';
        canvasContext.fillStyle = '#e6ebef';
        wrapLabel(graph.node(node.id).label).forEach((line, index) => {
          const lineY = node.y + radius + 3 * pixel + index * fontSize * 1.15;
          canvasContext.strokeText(line, node.x, lineY);
          canvasContext.fillText(line, node.x, lineY);
        });
      }

      canvasContext.restore();
    }

    function paintPointerArea(node, color, canvasContext) {
      canvasContext.fillStyle = color;
      canvasContext.beginPath();
      canvasContext.arc(node.x, node.y, radiusOf(node) + 3, 0, 2 * Math.PI);
      canvasContext.fill();
    }

    function viewportCenter() {
      return forceGraph.screen2GraphCoords(container.clientWidth / 2, container.clientHeight / 2);
    }

    function spawnPosition(id, fallback) {
      const anchorId = graph.neighboursOf(id).find((neighbourId) => nodeObjects.has(neighbourId));
      const anchor = anchorId ? nodeObjects.get(anchorId) : fallback;
      const angle = Math.random() * Math.PI * 2;
      return {
        x: (anchor.x || 0) + SPAWN_RADIUS * Math.cos(angle),
        y: (anchor.y || 0) + SPAWN_RADIUS * Math.sin(angle),
      };
    }

    function applyChange(change, anchorId) {
      change.removed.forEach((id) => nodeObjects.delete(id));
      linkObjects.forEach((link, linkId) => {
        if (!nodeObjects.has(endpointId(link.source)) || !nodeObjects.has(endpointId(link.target))) {
          linkObjects.delete(linkId);
        }
      });

      const fallback = anchorId && nodeObjects.has(anchorId) ? nodeObjects.get(anchorId) : viewportCenter();
      change.added.forEach((id) => {
        const data = graph.node(id);
        const position = spawnPosition(id, fallback);
        nodeObjects.set(id, {
          id: data.id,
          kind: data.kind,
          x: position.x,
          y: position.y,
        });
      });

      explorer.edgesTouching(change.added).forEach((edge) => {
        if (!linkObjects.has(edge.id)) {
          linkObjects.set(edge.id, {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            relation: edge.relation,
          });
        }
      });

      expandable.clear();
      nodeObjects.forEach((node, id) => {
        if (explorer.hasHiddenNeighbours(id)) {
          expandable.add(id);
        }
      });

      forceGraph.graphData({
        nodes: Array.from(nodeObjects.values()),
        links: Array.from(linkObjects.values()),
      });
    }

    function releasePin(id) {
      const node = nodeObjects.get(id);
      if (node && !node.pinned) {
        node.fx = undefined;
        node.fy = undefined;
      }
    }

    function select(id) {
      if (selectedId && selectedId !== id) {
        releasePin(selectedId);
      }
      selectedId = id;
      neighbourIds = new Set(graph.neighboursOf(id));
      const node = nodeObjects.get(id);
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
      }
      panel.show(id);
    }

    function clearSelection() {
      if (selectedId) {
        releasePin(selectedId);
      }
      selectedId = null;
      neighbourIds = new Set();
      panel.clear();
    }

    function centerOn(id) {
      const node = nodeObjects.get(id);
      if (node) {
        forceGraph.centerAt(node.x, node.y, VIEW_ANIMATION_MS);
      }
    }

    /* Once the spawned neighbours have spread out, zoom out just enough for
     * the selected node and its neighbours to fit. Never zooms in. */
    function frameSelection() {
      if (!selectedId) {
        return;
      }
      const nodes = [selectedId, ...neighbourIds]
        .filter((id) => nodeObjects.has(id))
        .map((id) => nodeObjects.get(id));
      const minX = Math.min(...nodes.map((node) => node.x));
      const maxX = Math.max(...nodes.map((node) => node.x));
      const minY = Math.min(...nodes.map((node) => node.y));
      const maxY = Math.max(...nodes.map((node) => node.y));
      const padding = 80;
      const fitZoom = Math.min(
        (container.clientWidth - 2 * padding) / Math.max(maxX - minX, 1),
        (container.clientHeight - 2 * padding) / Math.max(maxY - minY, 1),
      );
      const zoom = Math.min(forceGraph.zoom(), fitZoom);
      forceGraph.centerAt((minX + maxX) / 2, (minY + maxY) / 2, VIEW_ANIMATION_MS);
      forceGraph.zoom(zoom, VIEW_ANIMATION_MS);
    }

    function openNode(id, change) {
      applyChange(change, id);
      select(id);
      centerOn(id);
      clearTimeout(frameTimer);
      frameTimer = setTimeout(frameSelection, FRAME_DELAY_MS);
    }

    function focusNode(id) {
      openNode(id, explorer.expand(id));
    }

    function reset() {
      nodeObjects.clear();
      linkObjects.clear();
      selectedId = null;
      neighbourIds = new Set();
      panel.clear();
      fitWhenSettled = true;
      applyChange(explorer.reset(), null);
    }

    function expandAll() {
      fitWhenSettled = true;
      applyChange(explorer.expandAll(), selectedId);
    }

    const languageSelect = document.getElementById('language');
    AdhdMapI18n.fillLanguageSelect(languageSelect, languageIndex, initialCode);
    languageSelect.addEventListener('change', async () => {
      const code = languageSelect.value;
      await graph.loadLanguage(languageFileUrl(languageIndex, code));
      AdhdMapI18n.remember(code);
      AdhdMapI18n.applyUiStrings(graph.ui, code);
      panel.refresh();
    });

    document.getElementById('reset').addEventListener('click', reset);
    document.getElementById('expand-all').addEventListener('click', expandAll);
    document.getElementById('fit').addEventListener('click', () => forceGraph.zoomToFit(VIEW_ANIMATION_MS, 70));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        clearSelection();
      }
    });

    /* Small hook for tools/smoke-test.mjs: page coordinates of a node. */
    window.adhdMapDebug = {
      explorer,
      nodeScreenPosition(id) {
        const node = nodeObjects.get(id);
        const screen = forceGraph.graph2ScreenCoords(node.x, node.y);
        const rect = container.getBoundingClientRect();
        return { x: rect.left + screen.x, y: rect.top + screen.y };
      },
    };

    reset();
  }

  function languageFileUrl(index, code) {
    return `../data/${AdhdMapI18n.fileFor(index, code)}`;
  }

  main().catch((error) => {
    const box = document.createElement('div');
    box.className = 'error';
    box.textContent = error.message;
    document.getElementById('graph').append(box);
    console.error(error);
  });
})();
