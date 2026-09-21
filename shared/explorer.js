/* Visibility state shared by both prototypes: which nodes are currently on
 * screen, and what changes when a node is expanded or collapsed. Renderers
 * only apply the returned diffs, so both behave identically. */
(function () {
  'use strict';

  function createExplorer(graph) {
    const visible = new Set();
    /* id -> ids that became visible when that node was expanded. Collapse
     * undoes exactly that, so the map folds the way it unfolded. */
    const revealedBy = new Map();

    function isVisible(id) {
      return visible.has(id);
    }

    function hiddenNeighbours(id) {
      return graph.neighboursOf(id).filter((neighbourId) => !visible.has(neighbourId));
    }

    function hasHiddenNeighbours(id) {
      return hiddenNeighbours(id).length > 0;
    }

    /* Show the node and every neighbour of it. Returns the ids that became visible. */
    function expand(id) {
      const added = [];
      if (!visible.has(id)) {
        visible.add(id);
        added.push(id);
      }
      const revealed = hiddenNeighbours(id);
      revealed.forEach((neighbourId) => {
        visible.add(neighbourId);
        added.push(neighbourId);
      });
      if (revealed.length > 0) {
        revealedBy.set(id, (revealedBy.get(id) || []).concat(revealed));
      }
      return { added, removed: [] };
    }

    /* Hide what expanding this node revealed, and whatever those nodes
     * revealed in turn. Nodes revealed by other expansions stay, and the
     * start node is never hidden. */
    function collapse(id) {
      const removed = [];
      function fold(ownerId) {
        const children = revealedBy.get(ownerId) || [];
        revealedBy.delete(ownerId);
        children.forEach((childId) => {
          if (childId === graph.start || !visible.has(childId)) {
            return;
          }
          fold(childId);
          visible.delete(childId);
          removed.push(childId);
        });
      }
      fold(id);
      return { added: [], removed };
    }

    /* How many nodes a collapse of this node would fold away. */
    function revealedCount(id) {
      return (revealedBy.get(id) || []).filter((childId) => visible.has(childId)).length;
    }

    function toggle(id) {
      return hasHiddenNeighbours(id) ? expand(id) : collapse(id);
    }

    /* Clear everything and show the start node with its neighbours. The
     * renderer is expected to drop all of its elements before applying. */
    function reset() {
      visible.clear();
      revealedBy.clear();
      return expand(graph.start);
    }

    function expandAll() {
      const added = graph.nodes
        .map((node) => node.id)
        .filter((id) => !visible.has(id));
      added.forEach((id) => visible.add(id));
      return { added, removed: [] };
    }

    /* Edges between visible nodes that touch at least one of the given ids. */
    function edgesTouching(ids) {
      const touched = new Set(ids);
      return graph.edges.filter(
        (edge) =>
          visible.has(edge.source) &&
          visible.has(edge.target) &&
          (touched.has(edge.source) || touched.has(edge.target)),
      );
    }

    function visibleIds() {
      return Array.from(visible);
    }

    return {
      isVisible,
      hiddenNeighbours,
      hasHiddenNeighbours,
      revealedCount,
      expand,
      collapse,
      toggle,
      reset,
      expandAll,
      edgesTouching,
      visibleIds,
    };
  }

  window.AdhdMapExplorer = { createExplorer };
})();
