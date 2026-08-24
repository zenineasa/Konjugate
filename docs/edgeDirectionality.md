<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Edge and relationship directionality

A relationship can update one side, update both sides identically, or update both sides with opposite sign -- and which of the three it does isn't just a labeling choice, it changes the resulting numbers. The same worked example runs through every case below so the results are directly comparable: two identical nodes A and B, both starting at 0, connected by a relationship whose equation is the constant `0.01`, run for 10 seconds.

## Directed edge

The baseline case. The equation is evaluated once and contributes only to its own output state -- normally the target, though the output picker can point it at the source's own state instead. A → B, equation `0.01`: B ends at 0.1, A is untouched.

## Bidirectional edge

A single edge marked `directionality: "bidirectional"` still has one designated source and one target -- the user's own choice when connecting the two nodes -- but the engine evaluates the equation once and applies the result to *both* sides, negated on the far one: what leaves one enters the other (`engine/src/executionPlan.cpp`). With A as source and B as target, equation `0.01`: B ends at +0.1, A ends at −0.1.

This is correct, and exactly what a genuine conserved-quantity flux needs, provided the equation is anti-symmetric under swapping source and target -- i.e. it's actually a function of `sourceX − targetX`, the way real heat, mass or current transfer always is. Swap which node is source and the formula's sign flips too, but the physical result (flow from hot to cold) doesn't change. A bare constant is the sharp counterexample: it doesn't reference source or target at all, so it isn't anti-symmetric, and the ±0.1 split ends up dictated purely by which node was arbitrarily labeled "target" -- not by anything physical.

## Two directed edges, same equation, opposite roles

What an [edge group](edgeGroups.md)'s mesh uses instead of one bidirectional edge per pair: one ordinary directed edge A → B and a second, independent one B → A, both carrying the identical equation. Each is evaluated on its own, with its own source/target bindings, and lands on its own target -- there is no mirroring or sign flip at all. Equation `0.01`: A → B contributes +0.1 to B; B → A independently contributes +0.1 to A. Both end at +0.1.

For a genuinely anti-symmetric flux equation, this reduces to identical numbers as the bidirectional case: `k·(sourceX − targetX)` evaluated as A → B gives `k·(A−B)`; evaluated as B → A gives `k·(B−A)`, which is just the negative of the first. Nothing is lost for real physics -- the two directed edges naturally reconstruct the same conserved exchange a single bidirectional edge would, without needing an explicit sign-flip mechanism to enforce it.

This is why edge groups use this shape rather than one bidirectional edge per pair: a group has no single user-chosen source and target for a given pair the way a hand-authored edge does, so an arbitrary role assignment across the mesh would be unavoidable with only one edge per pair. Two independent directed edges sidestep the question instead of answering it arbitrarily -- every member is source against every other member exactly once, and target exactly once, by construction, so there is nothing arbitrary left to get wrong.

## A two-member edge group is not a bidirectional edge

Same node count, same "connect these two" intent -- but a 2-member edge group behaves like the *two directed edges* case above, not the bidirectional case, even though there is only one pair involved. For an anti-symmetric flux equation the two are numerically identical, so this rarely shows up in practice; for anything that isn't -- a bare constant, most obviously -- it does. Someone who genuinely wants sign-flip, conserved-exchange semantics for exactly two nodes should use an ordinary bidirectional edge, not a 2-member group.

## Choosing between them

- One-way contribution, with no counter-effect on the other side -- an ordinary directed edge.
- Exactly two nodes, a real conserved quantity flowing between them, equation written as `sourceX − targetX` -- an ordinary bidirectional edge, with source and target chosen deliberately.
- The same interaction replicated across three or more nodes, or a two-node case authored the same way a larger mesh would be -- an edge group, with the equation written the same anti-symmetric way for physically sound results across every pair.
