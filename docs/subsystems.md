---
type: Architecture
title: Subsystems
description: Authoring-hierarchy container specification, live boundary crossings and terminals, the lifecycle (rename, dissolve, delete, move in and out), and automatic flattening before engine simulation.
tags: [subsystems, hierarchy, canvas, ports, rename, dissolve, move]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Subsystems

Subsystems are authored hierarchy over Konjugate's graph, not separate simulation entities. A subsystem owns a stable numeric ID, a parent subsystem ID, a name and a display position. Nodes retain their original IDs and identify the subsystem that contains them. Relationships also retain their original endpoints and IDs.

## Boundary crossings

A subsystem's boundary is not stored. Which relationships cross it is derived, whenever it is shown, from the current edges and node membership by `subsystemBoundaryCrossings` in `src/subsystems.mjs`, the one function both the parent view and the inside view use (see [Design principles](designPrinciples.md)). A relationship crosses a subsystem's boundary when exactly one of its endpoints is inside, counting nodes in nested subsystems as inside; the other endpoint may be at the top level, in a parent subsystem or in a sibling. Each crossing names the relationship, its inside and outside node, whether the inside node is the relationship's source or target, and its direction seen from inside: incoming when the outside node is the source, outgoing when it is the target, and bidirectional for a relationship that applies its result to both ends (see [Edge and relationship directionality](edgeDirectionality.md)). Edge-group members are ordinary relationships here: a group spanning the boundary has one member crossing each way for every inside and outside pair. Deleted entities are left out, so adding, deleting, reconnecting or undoing a relationship, or moving a node in or out, changes the boundary at once. Multiple relationships between the same pair of nodes stay separate crossings.

Earlier versions recorded a `ports` array on each subsystem when it was created and never updated it, so the count it gave went stale as soon as a relationship was added or deleted. A file with stored ports still opens: the field is read past without being checked, even when it names a relationship that has since been deleted, and it is not written again. Konjugate no longer writes `ports`, because a derived copy saved beside the edges it is derived from can only disagree with them; an older Konjugate opening a newer file finds no ports and reads it as before, showing a count of zero on the proxy.

## Views

The parent view renders a subsystem proxy, labelled with the subsystem's name, its current number of boundary crossings and an Open button. A relationship that crosses the boundary is drawn to that proxy, while relationships whose endpoints are both inside the subsystem are hidden at the parent level. A click on the proxy selects it and opens its card; its Open button, a double click, or Open subsystem in its card or right-click menu steps inside, which shows its direct member nodes and nested subsystem proxies. The breadcrumb returns to the parent view.

Inside a subsystem, every crossing is drawn as a terminal at the side of the view, standing in for the node outside, and the relationship itself runs from that terminal to the inside node (or to the proxy of the nested subsystem holding it). Terminals for relationships whose outside node is the source (incoming) stand on the left, and those whose outside node is the target (outgoing, or the far end of a bidirectional relationship whose source is inside) on the right, ordered by the height of their inside node so that few lines cross. Each terminal is marked "→ In", "Out →" or "⇄ Both" and names the outside node, with the state the relationship binds on that node, where that node is (its subsystem path from Model) and, for an edge-group member, the group. Clicking a terminal selects its relationship and opens its editor; the ↗ beside it leaves for the view that shows the outside node, with that node selected. Terminals are laid out on entering the subsystem and whenever its boundary changes, not while nodes are dragged.

## Lifecycle

Every operation below is one undo step, is refused while results are shown (the model is locked then), and works the same in the desktop and the web edition. What each one touches is worked out by pure functions in `src/subsystems.mjs` (`subsystemContents`, `subsystemDeletion`, `subsystemLocations`, `subsystemMoveTargets`), which the canvas applies; their unit tests are in `tests/subsystems.test.mjs`.

- **The card.** Selecting a subsystem opens its card: its name, what it holds ("1 node · 1 subsystem inside · 2 nodes in all · 5 boundary ports · in Model"), its boundary crossings as the terminals inside name them, and the buttons Open subsystem, Dissolve subsystem and Delete subsystem. The same actions, with Rename subsystem, are on its right-click menu, and the Delete key deletes a selected subsystem.
- **Rename.** Type a new name in the card, or, while inside, click the subsystem's name in the breadcrumb and type it there (Enter keeps it, Escape leaves it). A name is trimmed and at most 120 characters; an empty one is refused.
- **Dissolve.** Dissolve subsystem puts the subsystem's own nodes and nested subsystems into its parent, as they are, and removes it. Node and relationship ids are unchanged, so plots, results, run configurations and tuning setups still find them. Nodes that were deleted while inside it are handed to the parent too, so undoing their deletion later does not put them back into a subsystem that is gone.
- **Delete.** Delete subsystem deletes the subsystem, every subsystem and node inside it at any depth, the relationships among them, and the relationships connecting them to the rest of the model, after a confirmation that counts each ("Delete “Plant”? This also deletes 2 nodes, 1 nested subsystem, 1 relationship inside it, 5 relationships connecting it to the rest of the model. Undo brings them back.").
- **Move in and out.** Right-click selected nodes for "Move into “Name”", one entry for each subsystem shown beside them, and, inside a subsystem, "Move to parent", which puts them a level up. A node's editor has a Subsystem field listing every place by path ("Model / Plant / Pump"), so a node can be moved to any level, nested ones included, in one step. Dragging nodes and dropping them on a subsystem's box moves them inside, where they were dropped, as one undo step with the drag. Relationships between moved and unmoved nodes stay as they are; those that now cross a boundary are drawn to the box outside and to a terminal inside.
- A subsystem being viewed that goes away (deleted, dissolved, or its creation undone) gives way to the nearest one still there, or the model.

Named and typed ports, exposed parameters, reusable definitions placed as several instances, and subsystems saved to their own files are a separate design, the subsystem components proposal; none of it is built yet.

Hierarchy visibility is independent of deletion. Saving a project always includes every undeleted graph entity, including entities outside the active hierarchy view. Before validation or simulation, Electron removes subsystem metadata and sends the native engine the same flat node-and-edge graph that would exist without subsystems. The C++ validator therefore remains the source of truth and numerical behavior is unchanged.
