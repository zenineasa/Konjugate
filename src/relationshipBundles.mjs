/* Copyright © 2026 Zenin Easa Panthakkalakath */

export function groupRelationshipBundles(relationships, isVisible = () => true) {
    const groups = new Map();
    relationships.forEach((relationship) => {
        if (!isVisible(relationship)) return;
        const [source, target] = [relationship.source, relationship.target].sort();
        const key = `${source}|${target}`;
        if (!groups.has(key)) groups.set(key, { key, source, target, relationships: [] });
        groups.get(key).relationships.push(relationship);
    });
    return [...groups.values()].filter((group) => group.relationships.length > 0);
}
