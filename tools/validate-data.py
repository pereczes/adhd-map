#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Validate the structure file and every language file.

Structure (data/adhd-map.yaml): ids, kinds, relations, reachability, and the
scope and evidence fields.
Languages (data/languages.yaml + data/lang/*.yaml): every node, kind, scope,
evidence level, relation, noted edge and interface string has a text in every
language, and no language file refers to an id that does not exist.

Every symptom node must carry an explicit scope. There is deliberately no
default: a node without one would otherwise read to a visitor as a diagnostic
symptom of ADHD.
"""

SCOPES = ("core", "associated", "transdiagnostic", "co-occurring", "unspecified")
EVIDENCE = ("guideline", "research", "reported")
SCOPE_REQUIRED_KINDS = ("symptom",)
EVIDENCE_REQUIRED_KINDS = ("strategy", "treatment")

import sys
from collections import defaultdict
from pathlib import Path

import yaml

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def load(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def validate_structure(structure, problems: list[str]):
    kinds = structure.get("kinds", {})
    relations = structure.get("relations", {})
    nodes = structure.get("nodes", [])
    edges = structure.get("edges", [])

    sources = structure.get("sources", {}) or {}
    for key, source in sources.items():
        for field in ("label", "title", "url"):
            if not source.get(field):
                problems.append(f"source {key}: missing `{field}`")

    node_ids: set[str] = set()
    for node in nodes:
        node_id = node.get("id")
        if not node_id:
            problems.append(f"node without id: {node}")
            continue
        if node_id in node_ids:
            problems.append(f"duplicate node id: {node_id}")
        node_ids.add(node_id)
        kind = node.get("kind")
        if kind not in kinds:
            problems.append(f"node {node_id}: unknown kind {kind!r}")
        scope = node.get("scope")
        if scope is not None and scope not in SCOPES:
            problems.append(f"node {node_id}: unknown scope {scope!r}")
        if scope is None and kind in SCOPE_REQUIRED_KINDS:
            problems.append(f"node {node_id}: a {kind} node must state its scope, one of {', '.join(SCOPES)}")
        for field in ("references", "sources"):
            for key in node.get(field, []) or []:
                if key not in sources:
                    problems.append(f"node {node_id}: {field} names unknown source {key!r}")
        evidence = node.get("evidence")
        if evidence is not None and evidence not in EVIDENCE:
            problems.append(f"node {node_id}: unknown evidence level {evidence!r}")
        if evidence is None and kind in EVIDENCE_REQUIRED_KINDS:
            problems.append(f"node {node_id}: a {kind} node must state its evidence level, one of {', '.join(EVIDENCE)}")
        if evidence == "guideline" and not node.get("sources"):
            problems.append(f"node {node_id}: evidence `guideline` must name the guidance it rests on, in `sources`")

    neighbours: dict[str, set[str]] = defaultdict(set)
    seen_pairs: set[tuple[str, str, str]] = set()
    edge_ids: set[str] = set()
    for index, edge in enumerate(edges):
        source = edge.get("from")
        target = edge.get("to")
        relation = edge.get("relation")
        where = f"edge {index} ({source} -> {target})"
        if source not in node_ids:
            problems.append(f"{where}: unknown source id")
        if target not in node_ids:
            problems.append(f"{where}: unknown target id")
        if relation not in relations:
            problems.append(f"{where}: unknown relation {relation!r}")
        if source == target:
            problems.append(f"{where}: self loop")
        for key in edge.get("sources", []) or []:
            if key not in sources:
                problems.append(f"{where}: names unknown source {key!r}")
        if relation == "associated_with" and not edge.get("sources"):
            problems.append(f"{where}: an `associated_with` edge claims a population-level association and must name a source")
        pair = (source, target, relation)
        if pair in seen_pairs:
            problems.append(f"{where}: duplicate edge")
        seen_pairs.add(pair)
        explicit_id = edge.get("id")
        if explicit_id:
            if explicit_id in edge_ids:
                problems.append(f"{where}: duplicate edge id {explicit_id}")
            edge_ids.add(explicit_id)
        neighbours[source].add(target)
        neighbours[target].add(source)

    start = structure.get("start")
    if start not in node_ids:
        problems.append(f"start node {start!r} does not exist")
    else:
        reachable = {start}
        frontier = [start]
        while frontier:
            current = frontier.pop()
            for neighbour in neighbours[current]:
                if neighbour not in reachable:
                    reachable.add(neighbour)
                    frontier.append(neighbour)
        for node_id in sorted(node_ids - reachable):
            problems.append(f"node {node_id} is not reachable from {start}")

    for node_id in sorted(node_ids):
        if not neighbours[node_id]:
            problems.append(f"node {node_id} has no edges")

    per_kind = defaultdict(int)
    per_scope = defaultdict(int)
    per_evidence = defaultdict(int)
    for node in nodes:
        per_kind[node.get("kind")] += 1
        if node.get("scope"):
            per_scope[node["scope"]] += 1
        if node.get("evidence"):
            per_evidence[node["evidence"]] += 1
    print(f"structure: {len(nodes)} nodes, {len(edges)} edges, {len(edge_ids)} noted edges")
    for kind, count in sorted(per_kind.items()):
        print(f"  {kind}: {count}")
    print("  scope: " + ", ".join(f"{scope} {count}" for scope, count in sorted(per_scope.items())))
    print("  evidence: " + ", ".join(f"{level} {count}" for level, count in sorted(per_evidence.items())))
    unsourced = [node["id"] for node in nodes if node.get("evidence") == "research" and not node.get("sources")]
    if unsourced:
        print(f"  note: {len(unsourced)} of the `research` nodes do not yet name a source. "
              "This is allowed, unlike `guideline`, but the count should fall over time.")

    return node_ids, set(kinds), set(relations), edge_ids, set(sources)


def validate_language(code: str, language, expected, reference_facts, reference_fact_sources, reference_ui_keys, problems: list[str]):
    node_ids, kind_ids, relation_ids, edge_ids, source_ids = expected
    prefix = f"lang {code}"

    if language.get("language") != code:
        problems.append(f"{prefix}: `language` is {language.get('language')!r}, expected {code!r}")
    for key in ("name", "title"):
        if not language.get(key):
            problems.append(f"{prefix}: missing `{key}`")

    ui_keys = set(language.get("ui", {}) or {})
    for key in sorted(reference_ui_keys - ui_keys):
        problems.append(f"{prefix}: missing ui string `{key}`")
    for key in sorted(ui_keys - reference_ui_keys):
        problems.append(f"{prefix}: unknown ui string `{key}`")

    for section, allowed in (("scopes", SCOPES), ("evidence", EVIDENCE)):
        values = language.get(section, {}) or {}
        for key in allowed:
            if not values.get(key):
                problems.append(f"{prefix}: missing {section} label `{key}`")
        for key in sorted(set(values) - set(allowed)):
            problems.append(f"{prefix}: unknown {section} key `{key}`")

    kinds = language.get("kinds", {}) or {}
    for kind_id in sorted(kind_ids - set(kinds)):
        problems.append(f"{prefix}: missing kind label `{kind_id}`")
    for kind_id in sorted(set(kinds) - kind_ids):
        problems.append(f"{prefix}: unknown kind `{kind_id}`")

    relations = language.get("relations", {}) or {}
    for relation_id in sorted(relation_ids - set(relations)):
        problems.append(f"{prefix}: missing relation `{relation_id}`")
    for relation_id in sorted(set(relations) - relation_ids):
        problems.append(f"{prefix}: unknown relation `{relation_id}`")
    for relation_id, text in relations.items():
        if not isinstance(text, dict) or not text.get("label") or not text.get("inverse"):
            problems.append(f"{prefix}: relation `{relation_id}` needs label and inverse")

    nodes = language.get("nodes", {}) or {}
    labels_by_text = {
        (text.get("label") or "").strip().lower(): node_id
        for node_id, text in nodes.items()
        if isinstance(text, dict)
    }
    alias_owners: dict[str, str] = {}
    for node_id in sorted(node_ids - set(nodes)):
        problems.append(f"{prefix}: missing node `{node_id}`")
    for node_id in sorted(set(nodes) - node_ids):
        problems.append(f"{prefix}: unknown node `{node_id}`")
    for node_id, text in nodes.items():
        if not isinstance(text, dict) or not text.get("label"):
            problems.append(f"{prefix}: node `{node_id}` has no label")
            continue
        if not text.get("description"):
            problems.append(f"{prefix}: node `{node_id}` has no description")
        aliases = text.get("aliases") or []
        if not isinstance(aliases, list) or any(not isinstance(alias, str) for alias in aliases):
            problems.append(f"{prefix}: node `{node_id}` aliases must be a list of strings")
            aliases = []
        seen_here = set()
        for alias in aliases:
            folded = alias.strip().lower()
            if folded in seen_here:
                problems.append(f"{prefix}: node `{node_id}` repeats the alias `{alias}`")
            seen_here.add(folded)
            owner = labels_by_text.get(folded)
            if owner and owner != node_id:
                problems.append(
                    f"{prefix}: node `{node_id}` has the alias `{alias}`, which is the label of `{owner}`. "
                    "Searching for it would open the other node.")
            other = alias_owners.get(folded)
            if other and other != node_id:
                problems.append(f"{prefix}: nodes `{other}` and `{node_id}` share the alias `{alias}`")
            alias_owners[folded] = node_id

        facts = text.get("facts") or []
        reference_sources = reference_fact_sources.get(node_id, [])
        if [fact.get("source") for fact in facts if isinstance(fact, dict)] != reference_sources and reference_sources:
            problems.append(
                f"{prefix}: node `{node_id}` cites different sources than the default language: "
                f"{[fact.get('source') for fact in facts if isinstance(fact, dict)]} against {reference_sources}")
        for index, fact in enumerate(facts):
            if not isinstance(fact, dict) or not fact.get("text"):
                problems.append(f"{prefix}: node `{node_id}` fact {index} has no text")
            source = (fact or {}).get("source")
            if source not in source_ids:
                problems.append(f"{prefix}: node `{node_id}` fact {index} cites unknown source {source!r}")
        expected_count = reference_facts.get(node_id, 0)
        if len(facts) != expected_count:
            problems.append(
                f"{prefix}: node `{node_id}` has {len(facts)} facts, the default language has {expected_count}")

    edges = language.get("edges", {}) or {}
    for edge_id in sorted(edge_ids - set(edges)):
        problems.append(f"{prefix}: missing note for edge `{edge_id}`")
    for edge_id in sorted(set(edges) - edge_ids):
        problems.append(f"{prefix}: unknown edge `{edge_id}` (give the edge an id in the structure file)")
    for edge_id, text in edges.items():
        if not isinstance(text, dict) or not text.get("note"):
            problems.append(f"{prefix}: edge `{edge_id}` has no note")

    fact_count = sum(len(text.get("facts") or []) for text in nodes.values() if isinstance(text, dict))
    print(f"lang {code}: {len(nodes)} nodes, {fact_count} facts, {len(edges)} notes, {len(ui_keys)} ui strings")


def main() -> int:
    problems: list[str] = []
    structure = load(DATA_DIR / "adhd-map.yaml")
    expected = validate_structure(structure, problems)

    index = load(DATA_DIR / "languages.yaml")
    languages = index.get("languages", [])
    codes = [entry.get("code") for entry in languages]
    default_code = index.get("default")
    if default_code not in codes:
        problems.append(f"languages.yaml: default {default_code!r} is not listed")

    documents = {}
    for entry in languages:
        code = entry.get("code")
        path = DATA_DIR / entry.get("file", "")
        if not path.is_file():
            problems.append(f"languages.yaml: file for {code!r} not found: {path}")
            continue
        documents[code] = load(path)

    reference = documents.get(default_code)
    reference_ui_keys = set((reference or {}).get("ui", {}) or {})
    reference_nodes = ((reference or {}).get("nodes", {}) or {}).items()
    reference_facts = {
        node_id: len(text.get("facts") or [])
        for node_id, text in reference_nodes
        if isinstance(text, dict)
    }
    reference_fact_sources = {
        node_id: [fact.get("source") for fact in (text.get("facts") or []) if isinstance(fact, dict)]
        for node_id, text in reference_nodes
        if isinstance(text, dict)
    }
    for code, language in documents.items():
        validate_language(code, language, expected, reference_facts, reference_fact_sources,
                          reference_ui_keys, problems)

    if problems:
        print(f"\n{len(problems)} problem(s):")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("\ndata files are valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
