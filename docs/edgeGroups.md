---
type: Architecture
title: Relationship groups
description: Shared relationship definitions that automatically instantiate across an all-to-all or selected mesh of member nodes.
tags: [graph, edge-groups, mesh, relationships]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Relationship groups

Relationship groups are authored relationship structure over Konjugate's graph, not a distinct simulation entity type. A group owns a stable numeric ID, a name, a display colour, a live list of member node IDs and one shared relationship definition -- an equation or a `cpp`/`python` implementation, plus parameters. Member relationships retain their own IDs and identify the group that produced them.

Creating a group from a selected set of nodes expands the shared definition into a complete mesh: one directed relationship for every ordered member pair -- both A → B and B → A, independently evaluated, never a single bidirectional relationship -- each bound to its own two nodes by matching state symbol, the same auto-bind mechanism the component library's relationship templates use. See [Relationship and relationship directionality](edgeDirectionality.md) for why groups use two directed relationships per pair rather than one bidirectional relationship, and how the numbers differ. Adding a node to an existing group creates its relationships, in both directions, to every current member. Detaching a node clears the group reference on its relationships to and from the rest of the group, leaving them behind as ordinary, independently editable relationships rather than deleting them.

No member relationship may diverge from the group's own definition. Editing a group's equation, implementation or parameters re-resolves and overwrites every current member relationship; the only way to give one member's interaction a different value is to detach it first. Clicking a member relationship opens the group's own editor rather than the ordinary single-relationship editor. Deleting a group removes only its own remaining member relationships, leaving anything already detached untouched.

Group membership is independent of deletion the same way subsystem hierarchy is: saving a project always includes every undeleted mesh relationship. Before validation or simulation, Electron removes group metadata and sends the native engine the same flat node-and-relationship graph it would see without groups. The C++ validator therefore remains the source of truth and numerical behavior is unchanged.
