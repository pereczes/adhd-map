#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Validate the structure file and every language file.

Structure (data/adhd-map.yaml): ids, kinds, relations, reachability.
Languages (data/languages.yaml + data/lang/*.yaml): every node, kind,
relation, noted edge and interface string has a text in every language,
and no language file refers to an id that does not exist.
"""

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

    node_ids: set[str] = set()
    for node in nodes:
        node_id = node.get("id")
        if not node_id:
            problems.append(f"node without id: {node}")
            continue
        if node_id in node_ids:
            problems.append(f"duplicate node id: {node_id}")
        node_ids.add(node_id)
        if node.get("kind") not in kinds:
            problems.append(f"node {node_id}: unknown kind {node.get('kind')!r}")

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
    for node in nodes:
        per_kind[node.get("kind")] += 1
    print(f"structure: {len(nodes)} nodes, {len(edges)} edges, {len(edge_ids)} noted edges")
    for kind, count in sorted(per_kind.items()):
        print(f"  {kind}: {count}")

    return node_ids, set(kinds), set(relations), edge_ids


def validate_language(code: str, language, expected, reference_ui_keys, problems: list[str]):
    node_ids, kind_ids, relation_ids, edge_ids = expected
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
    for node_id in sorted(node_ids - set(nodes)):
        problems.append(f"{prefix}: missing node `{node_id}`")
    for node_id in sorted(set(nodes) - node_ids):
        problems.append(f"{prefix}: unknown node `{node_id}`")
    for node_id, text in nodes.items():
        if not isinstance(text, dict) or not text.get("label"):
            problems.append(f"{prefix}: node `{node_id}` has no label")
        elif not text.get("description"):
            problems.append(f"{prefix}: node `{node_id}` has no description")

    edges = language.get("edges", {}) or {}
    for edge_id in sorted(edge_ids - set(edges)):
        problems.append(f"{prefix}: missing note for edge `{edge_id}`")
    for edge_id in sorted(set(edges) - edge_ids):
        problems.append(f"{prefix}: unknown edge `{edge_id}` (give the edge an id in the structure file)")
    for edge_id, text in edges.items():
        if not isinstance(text, dict) or not text.get("note"):
            problems.append(f"{prefix}: edge `{edge_id}` has no note")

    print(f"lang {code}: {len(nodes)} nodes, {len(edges)} notes, {len(ui_keys)} ui strings")


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
    for code, language in documents.items():
        validate_language(code, language, expected, reference_ui_keys, problems)

    if problems:
        print(f"\n{len(problems)} problem(s):")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("\ndata files are valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
