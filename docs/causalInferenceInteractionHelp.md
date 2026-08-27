# Interaction effects

This checkbox controls whether causal inference is allowed to fit a relationship whose strength depends on *both* variables together — not just the source column predicting the target on its own.

## What it changes

Off (the default), every recovered edge is a function of the source column alone: `rate × source`, or a curved version of that if you've allowed curvature above. That covers most everyday coupling correctly — one thing driving another, one thing decaying toward another — with no loss of accuracy.

On, causal inference additionally tries a **product** term: `rate × source × target`. That's the shape needed for relationships where the *effect* of one variable on another depends on the target's own current value too — predator-prey dynamics, chemical reaction rates, infection spread between two populations. A source-only fit can never represent this kind of coupling, no matter how much data you give it; the interaction term is the only way to recover it.

## Should you turn it on?

If you don't know whether your system has this kind of coupling, it's safe to try. On a system that doesn't need it, turning this on costs a little extra fitting time and, occasionally, one small extra term with a coefficient close to zero — it won't change your results in any way that matters. On a system that does need it, it's the difference between recovering the real relationship and missing it entirely.

It's off by default because most systems don't need it, and keeping equations as simple as the data actually supports is usually the right call.
