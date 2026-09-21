/* Loads the structure file and a language file and exposes a normalised
 * graph object that both prototypes read. Requires js-yaml (global `jsyaml`).
 *
 * The structure file carries ids, kinds, relations and edges. All text
 * (labels, descriptions, edge notes, interface strings) comes from a
 * language file and can be swapped at runtime with graph.loadLanguage(). */
(function () {
  'use strict';

  async function loadYaml(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not load ${url}: HTTP ${response.status}`);
    }
    return jsyaml.load(await response.text());
  }

  async function loadGraph(structureUrl, languageUrl) {
    const [structure, language] = await Promise.all([loadYaml(structureUrl), loadYaml(languageUrl)]);
    const graph = buildGraph(structure);
    applyLanguage(graph, language);
    return graph;
  }

  function buildGraph(structure) {
    const kinds = {};
    Object.entries(structure.kinds || {}).forEach(([kindId, kind]) => {
      kinds[kindId] = { color: kind.color, size: kind.size || 1, label: kindId };
    });
    const relations = {};
    Object.entries(structure.relations || {}).forEach(([relationId, relation]) => {
      relations[relationId] = {
        color: relation.color,
        directed: Boolean(relation.directed),
        dashed: Boolean(relation.dashed),
        /* loop: part of a vicious cycle, drawn thick and animated.
         * via: a chaining relation; "what this reaches" follows it one hop
         * further (strategy produces mechanism, mechanism helps symptom). */
        loop: Boolean(relation.loop),
        via: Boolean(relation.via),
        label: relationId,
        inverse: relationId,
      };
    });

    const nodesById = new Map();
    const problems = [];

    (structure.nodes || []).forEach((node) => {
      if (nodesById.has(node.id)) {
        problems.push(`duplicate node id: ${node.id}`);
      }
      if (!kinds[node.kind]) {
        problems.push(`node ${node.id} has unknown kind: ${node.kind}`);
      }
      nodesById.set(node.id, { id: node.id, kind: node.kind, label: node.id, description: '' });
    });

    const edgeIds = new Set();
    const edges = (structure.edges || []).map((edge, index) => {
      const id = edge.id || `edge-${index}`;
      if (edgeIds.has(id)) {
        problems.push(`duplicate edge id: ${id}`);
      }
      edgeIds.add(id);
      if (!nodesById.has(edge.from)) {
        problems.push(`edge ${id}: unknown source ${edge.from}`);
      }
      if (!nodesById.has(edge.to)) {
        problems.push(`edge ${id}: unknown target ${edge.to}`);
      }
      if (!relations[edge.relation]) {
        problems.push(`edge ${id}: unknown relation ${edge.relation}`);
      }
      return { id, source: edge.from, target: edge.to, relation: edge.relation, note: '' };
    });

    if (problems.length > 0) {
      throw new Error(`Invalid structure file:\n${problems.join('\n')}`);
    }

    const adjacency = new Map();
    nodesById.forEach((node, id) => adjacency.set(id, []));
    edges.forEach((edge) => {
      adjacency.get(edge.source).push(edge);
      adjacency.get(edge.target).push(edge);
    });

    const neighbourCache = new Map();

    function neighboursOf(id) {
      if (!neighbourCache.has(id)) {
        const unique = new Set();
        (adjacency.get(id) || []).forEach((edge) => {
          unique.add(edge.source === id ? edge.target : edge.source);
        });
        neighbourCache.set(id, Array.from(unique));
      }
      return neighbourCache.get(id);
    }

    const graph = {
      title: 'Map',
      language: null,
      ui: {},
      start: structure.start,
      kinds,
      relations,
      nodes: Array.from(nodesById.values()),
      edges,
      node(id) {
        return nodesById.get(id);
      },
      edgesOf(id) {
        return adjacency.get(id) || [];
      },
      neighboursOf,
      kindOf(node) {
        return kinds[node.kind];
      },
      relationOf(edge) {
        return relations[edge.relation];
      },
      async loadLanguage(url) {
        applyLanguage(graph, await loadYaml(url));
      },
    };
    return graph;
  }

  /* Overwrite every piece of text on the graph from a language document.
   * Missing entries fall back to the id so gaps are visible, not fatal. */
  function applyLanguage(graph, language) {
    const kindTexts = language.kinds || {};
    const relationTexts = language.relations || {};
    const nodeTexts = language.nodes || {};
    const edgeTexts = language.edges || {};

    graph.language = language.language || null;
    graph.title = language.title || graph.title;
    graph.ui = language.ui || {};

    Object.entries(graph.kinds).forEach(([kindId, kind]) => {
      kind.label = kindTexts[kindId] || kindId;
    });
    Object.entries(graph.relations).forEach(([relationId, relation]) => {
      const text = relationTexts[relationId] || {};
      relation.label = text.label || relationId;
      relation.inverse = text.inverse || relation.label;
    });
    graph.nodes.forEach((node) => {
      const text = nodeTexts[node.id] || {};
      node.label = text.label || node.id;
      node.description = text.description || '';
    });
    graph.edges.forEach((edge) => {
      const text = edgeTexts[edge.id] || {};
      edge.note = text.note || '';
    });
  }

  window.AdhdMapData = { loadGraph, loadYaml };
})();
