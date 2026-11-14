---
type: Architecture
title: Subsystems
description: Authoring-hierarchy container specification, live boundary crossings and terminals, and automatic flattening before engine simulation.
tags: [subsystems, hierarchy, canvas, ports]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Subsystems

Subsystems are authored hierarchy over Konjugate's graph, not separate simulation entities. A subsystem owns a stable numeric ID, a parent subsystem ID, a name and a display position. Nodes retain their original IDs and identify the subsystem that contains them. Relationships also retain their original endpoints and IDs.

## Boundary crossings

A subsystem's boundary is not stored. Which relationships cross it is derived, whenever it is shown, from the current edges and node membership by `subsystemBoundaryCrossings` in `src/subsystems.mjs`, the one function both the parent view and the inside view use (see [Design principles](designPrinciples.md)). A relationship crosses a subsystem's boundary when exactly one of its endpoints is inside, counting nodes in nested subsystems as inside; the other endpoint may be at the top level, in a parent subsystem or in a sibling. Each crossing names the relationship, its inside and outside node, whether the inside node is the relationship's source or target, and its direction seen from inside: incoming when the outside node is the source, outgoing when it is the target, and bidirectional for a relationship that applies its result to both ends (see [Edge and relationship directionality](edgeDirectionality.md)). Edge-group members are ordinary relationships here: a group spanning the boundary has one member crossing each way for every inside and outside pair. Deleted entities are left out, so adding, deleting, reconnecting or undoing a relationship, or moving a node in or out, changes the boundary at once. Multiple relationships between the same pair of nodes stay separate crossings.

Earlier versions recorded a `ports` array on each subsystem when it was created and never updated it, so the count it gave went stale as soon as a relationship was added or deleted. A file with stored ports still opens: the field is read past without being checked, even when it names a relationship that has since been deleted, and it is not written again. Konjugate no longer writes `ports`, because a derived copy saved beside the edges it is derived from can only disagree with them; an older Konjugate opening a newer file finds no ports and reads it as before, showing a count of zero on the proxy.

## Views

The parent view renders a subsystem proxy, labelled with the subsystem's name and its current number of boundary crossings. A relationship that crosses the boundary is drawn to that proxy, while relationships whose endpoints are both inside the subsystem are hidden at the parent level. Opening the proxy shows its direct member nodes and nested subsystem proxies. The breadcrumb returns to the parent view.

Inside a subsystem, every crossing is drawn as a terminal at the side of the view, standing in for the node outside, and the relationship itself runs from that terminal to the inside node (or to the proxy of the nested subsystem holding it). Terminals for relationships whose outside node is the source (incoming) stand on the left, and those whose outside node is the target (outgoing, or the far end of a bidirectional relationship whose source is inside) on the right, ordered by the height of their inside node so that few lines cross. Each terminal is marked "→ In", "Out →" or "⇄ Both" and names the outside node, with the state the relationship binds on that node, where that node is (its subsystem path from Model) and, for an edge-group member, the group. Clicking a terminal selects its relationship and opens its editor; the ↗ beside it leaves for the view that shows the outside node, with that node selected. Terminals are laid out on entering the subsystem and whenever its boundary changes, not while nodes are dragged.

Hierarchy visibility is independent of deletion. Saving a project always includes every undeleted graph entity, including entities outside the active hierarchy view. Before validation or simulation, Electron removes subsystem metadata and sends the native engine the same flat node-and-edge graph that would exist without subsystems. The C++ validator therefore remains the source of truth and numerical behavior is unchanged.
