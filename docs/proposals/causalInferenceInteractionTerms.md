<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Causal inference: recovering non-separable source/target interaction terms

**Status: shipped.** [Causal inference](../causalInference.md)'s "Interaction terms (v3)" section is now the reference for the shipped mathematics and code; this document records the design discussion that led there. It documents a gap found while reviewing causal inference against Konjugate's general per-node equation, `ẋᵢ = Σⱼ f_ij(xᵢ,xⱼ) + sᵢ(xᵢ,u)`, and the design that closed it. `InferenceConfig::includeInteractionTerms` (`engine/include/causalInference.hpp`), the feature/destandardization/gating changes in `engine/src/causalInference.cpp`, the `InteractionTerm` JSON field (`engine/src/causalInferenceReport.cpp`), the `--include-interaction-terms` CLI flag (`engine/src/main.cpp`, `docs/engineCli.md`), and the renderer-side equation generation and UI checkbox (`src/renderer/renderer.mjs`, `src/renderer/index.html`, `src/engineAdapter.mjs`) are all implemented, covered by `engine/tests/causalInferenceTests.cpp`'s `inferGraphRecoversANonSeparableInteractionTerm`/`inferGraphOmitsInteractionTermsByDefault`, and verified end-to-end against a synthetic bilinear (Lotka-Volterra-style) system: recovered linear coefficient 1.99 (true 2.0), interaction coefficient 0.79 (true 0.8), self-rate −0.59 (true −0.6). Everything below describes the shipped design as-built; the destandardization derivation and the "Decided" resolution were confirmed exactly by the numbers above, not just algebraically.

## Problem

Every edge in Konjugate's execution model is a genuine joint function of both its endpoints — an edge's `equationModel`/`implementation` bindings expose both the source's and the target's own state, and the shipped `rodX`/`rodY`/`rodZ` component-library templates rely on exactly this: their spring term is built from `(targetX − sourceX)`, not from `sourceX` or `targetX` alone (`assets/componentLibrary/rodX.json:11`; schema for dual-endpoint bindings in `docs/projectSchema.md:22-43`).

Causal inference's stage 2 (`engine/src/causalInference.cpp:284-434`) cannot recover a relationship of that shape in general. Its design matrix per target *i* is built from powers of each source column alone (`x_j, x_j², …`) plus one separate linear self-lag column for `x_i` (`causalInference.cpp:248-322`, `featureCount = sources.size()*degree + 1`) — no feature ever combines `x_i` and `x_j`.

**This is a narrower gap than it first looks.** Because the self-lag and every source column are fit *jointly* in one regression, a linear, additively-separable relationship like `ẋᵢ = rate·xⱼ − rate·xᵢ` (diffusion/relaxation coupling) is already recovered exactly today: the edge carries `+rate·xⱼ`, the shared self-term absorbs `−rate·xᵢ` (aggregated correctly across every surviving source, since a linear self-lag column is one shared feature), and summing them reproduces the true joint rule. No fix is needed for this case, and `rodX`'s *position* term is actually an instance of it.

The irreducible gap is **non-separable** joint terms — anything that cannot be written as `g(xᵢ) + h(xⱼ)`. The canonical case is bilinear/product coupling, `xᵢ·xⱼ`: mass-action kinetics, Lotka-Volterra predator-prey (`ẋ_prey = a·x_prey − b·x_prey·x_predator`), SIR-style epidemiological compartments, chemical reaction networks. No decomposition into an edge-of-`xⱼ` plus a self-term-of-`xᵢ` can reconstruct a product term, and no feature in the current design matrix represents one. (`rodX`'s *velocity*-damping term is a different, harder problem — it couples a different state, `vx`, across two nodes, which single-CSV-column-per-node causal inference has no representation for at all; out of scope here, see "Non-goals.")

## Proposed feature: `xᵢ(t−1)·xⱼ(t−1)`

Add one interaction feature per surviving source `j` against target `i`, to the same joint ridge fit that already includes `j`'s polynomial terms and `i`'s self-lag.

### Destandardization

Following the precedent v2 already set for degree ≥ 2 (`docs/causalInference.md:58-66`): a mean-centered standardized feature spreads under multiplication (binomial-expansion cross-contamination), so the interaction feature must use **scale-only** normalization for both sides, exactly like the existing degree-≥2 columns do: `v_i = x_i/σ_i`, `v_j = x_j/σ_j` (no mean subtraction). The raw feature is `w_ij = v_i · v_j = x_i·x_j / (σ_i·σ_j)` — a clean single term, no cross-degree leakage into the linear terms. As with every other feature, it's divided by its own training-set RMS scale `s_ij` before entering the ridge design matrix, for the same reason `s_p` normalizes each polynomial degree today: so the penalty treats every feature fairly regardless of its natural scale.

Recovering the original-units coefficient from the fitted standardized weight `γ_ij`:

```
contribution to y_std   = γ_ij · w_ij/s_ij = γ_ij · xᵢ·xⱼ / (σᵢ·σⱼ·s_ij)
contribution to xᵢ(t)   = σᵢ · (above)      = γ_ij · xᵢ·xⱼ / (σⱼ·s_ij)

coefficient_ij = γ_ij / (σⱼ · s_ij)
```

`σᵢ` cancels exactly — it enters once dividing (inside the feature) and once multiplying (destandardizing the target), which is a clean sanity check that the derivation is right. No intercept correction, same reasoning as degree ≥ 2: only a mean-centered term needs one, and `v_i, v_j` aren't mean-centered.

The `rate = coefficient/Δt` transform ([Causal inference](../causalInference.md)'s "From a candidate to a real equation") applies unchanged — this is a cross-term, not a self-transition, so there's no `−1`, same as any other polynomial cross-term today.

### Representation: a new term type, not `PolynomialTerm` or `SelfTerm`

An interaction term depends on both endpoints, so it's neither. Proposed:

```cpp
struct InteractionTerm {
    double coefficient = 0.0; // original units, post rate/Δt transform
};
```

attached per-source alongside `terms` (the existing `vector<PolynomialTerm>`) on `InferredEdge`. Equation generation (currently in the renderer, building LaTeX from `InferredEdge::terms` — `docs/causalInference.md:124`) needs to reference **both** `sourceX` and `targetX` symbols for this term, the same pattern `rodX.json` already uses for a hand-authored edge. No schema or execution-engine change is needed — `equationModel` already supports dual-endpoint bindings; this is purely fitting-side feature construction plus renderer-side equation generation.

### Acceptance gating

Proposed: extend the existing aggregate-magnitude gate rather than add a parallel one. Today, `aggregate_j = sqrt(Σ_p β_{j,p}²)` judges a source by its combined polynomial magnitude (`docs/causalInference.md:90-96`) — "a curved relationship is one edge with a multi-term equation, not independent per-degree decisions." Folding the interaction coefficient into the same sum-of-squares (`aggregate_j = sqrt(Σ_p β_{j,p}² + γ_ij²)`) extends that same philosophy to "one edge judged by any of its terms, linear, polynomial, or interaction" — no new threshold, no new concept.

### Decided: a global per-target toggle, not a per-source search

Unlike a self-lag (always exactly one extra column), an interaction feature is one extra column **per surviving source**, so `featureCount` becomes `sources.size()·(degree+1) + 1` when enabled. This resolves the same way `candidateDegrees` already resolved the analogous choice: `InferenceConfig::includeInteractionTerms` is a single top-level bool (default `false`, the user-facing opt-in — a checkbox, not a 3-way picker, since there's no sensible "interaction-only, no linear comparison" variant the way `candidateDegrees == {N}` forces a fixed nonlinear degree). When true, it becomes one more axis in the grid search that already runs per target — today `degree × penalty` since `candidateLags` is pinned to `{1}` — selected by the same adjusted held-out score already computed for every `(lag, degree, penalty)` combination. No new selection mechanism.

Within an "interaction on" fit, every surviving source gets one interaction column — not a combinatorial search over which subset of sources gets one. Whether any individual source's interaction term survives is left entirely to the existing aggregate-magnitude gate (`aggregate_j` extended to include `γ_ij²`, above) and to ridge's own shrinkage, exactly mirroring how degree ≥ 2 already works: degree is selected once, globally, per target; acceptance is still per-source.

**Accepted blind spot, by design, not by omission:** turning interaction on for a target with many sources inflates `featureCount` by `sources.size()`, and the DoF adjustment raises the bar for *every* source at that target, even ones with no real interaction — a target with one genuinely-bilinear source among many purely-linear ones pays a uniform penalty. A more surgical per-source search (only add an interaction column for sources whose linear-only fit already underperforms) would avoid this, but the project already has a directly analogous precedent for rejecting that kind of fix: stage 1's adaptive per-subset conditioning search was prototyped specifically to fix an analogous blind spot (collider bias), and was rejected because it introduced a *worse* failure mode — numerical instability from near-collinear small-subset conditioning (`docs/causalInference.md:31-33`). Same judgment applies here: ship the simple global toggle, document the DoF-dilution blind spot honestly, and only build a per-source search if real usage demonstrates it matters.

### Consequence for the degrees-of-freedom-adjusted score

The adjusted score (`docs/causalInference.md:80-88`) exists precisely because a richer feature set gives ridge's shrinkage more room to produce a spuriously-scoring fit — the exact risk profile an interaction feature raises, arguably more acutely, since a product term is collinear with the two linear terms whenever `xᵢ,xⱼ` are already correlated on their own (a product can partially masquerade as a combination of the linear terms unless there's genuine interaction signal, not just correlation). **Confirmed on implementation:** the existing `adjustedHeldOutScore` formula applies unchanged (it's already parameterized by feature count) with no retuning needed — `inferGraphRecoversANonSeparableInteractionTerm` (`engine/tests/causalInferenceTests.cpp`) fit against a known synthetic bilinear system recovered the true interaction coefficient (0.8) to within 0.02, and the linear/self-lag terms alongside it, without any change to the DoF-adjustment formula itself.

### Stage-1 skeleton blind spot

Stage 1 screens on linear lag-1 partial correlation only. A pure product relationship can have near-zero linear correlation in some regimes (e.g. near an equilibrium where one factor is small), so a genuinely interaction-only pair could be pruned before stage 2 ever gets a chance — the same class of known boundary already documented for polynomial degrees (`docs/causalInference.md:68`), extended here rather than newly discovered. Not proposed to be fixed as part of this; flagged as the same honest caveat.

## Non-goals

- **Cross-state coupling** (a relationship depending on a *different* state of the same two nodes, e.g. `rodX`'s velocity-damping term, or any relationship that needs two CSV columns per node rather than one). Causal inference's CSV model is one column ↔ one scalar state; representing "this node has multiple co-varying states" is a materially larger generalization (CSV-column-to-node grouping) than adding one feature type, and isn't addressed here.
- **A nonlinear self-term** (`sᵢ(xᵢ)` beyond linear, e.g. logistic self-limiting `xᵢ²`). Real gap, smaller and orthogonal to this one (the self-lag control term is hardcoded linear today regardless of `candidateDegrees` — "its job is absorbing the target's own persistence as a nuisance variable... giving it its own polynomial expansion would risk it soaking up variance" per `docs/causalInference.md:37`). Would need its own reasoning about whether that risk still holds once the self-lag is allowed to be part of a reported term rather than pure nuisance; not resolved here.
- **Exogenous input `u`.** Causal inference has no notion of a control/driving input distinct from an ordinary node; an input column is just another CSV column that happens to have no incoming edges. Not addressed here.

## Testing plan

**Shipped.** Following the project's existing validation pattern (a known-ground-truth synthetic system, not just in-sample fit score): `makeInteractionPairSeries` in `engine/tests/causalInferenceTests.cpp` builds a two-node system with a genuine bilinear coupling term (`target[t] = 0.4·target[t−1] + 2.0·source[t−1] + 0.8·source[t−1]·target[t−1] + noise`, source a plain independent AR(1)). `inferGraphRecoversANonSeparableInteractionTerm` fits it with `includeInteractionTerms = true` and checks the linear, interaction and self-lag coefficients all land close to their true values; `inferGraphOmitsInteractionTermsByDefault` checks the same series produces no interaction term when the config is left at its default. Both pass. A full trajectory-forward-simulation check (mirroring `tests/engine/continuousTimeDrift.mjs`) was not added — the existing rate/Δt transform is unchanged by this feature (an interaction term is a cross-term like any polynomial term, no new "−1" case), so it inherits the same drift characterization already established for every other term type rather than needing its own.

## Implementation

Shipped in this order: (1) the feature + `InteractionTerm` + destandardization math, gated behind `includeInteractionTerms` defaulting off (`engine/include/causalInference.hpp`, `engine/src/causalInference.cpp`); (2) folded into the existing aggregate-magnitude gate; (3) the new synthetic test, which confirmed the DoF-adjusted score needed no changes; (4) the JSON report field (`engine/src/causalInferenceReport.cpp`), CLI flag (`engine/src/main.cpp`, `docs/engineCli.md`), and renderer-side dual-endpoint equation generation plus the "Also test for interaction effects between related variables" checkbox (`src/renderer/renderer.mjs`, `src/renderer/index.html`, `src/engineAdapter.mjs`).
