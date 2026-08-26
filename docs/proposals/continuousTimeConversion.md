<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Discrete fit vs. continuous rate: the math, side by side

Companion note to [Causal inference (proposal)](causalInference.md)'s "Continuous time" section -- equations only, minimally explained. **Implemented, shipped as the opt-in "Fit for continuous-time simulation" mode** -- see [Causal inference](../causalInference.md)'s own "Continuous-time mode" section for the current, product-facing description. This doc keeps the math history: the approach that was tried, rejected, and the different, simpler approach that actually shipped.

## Two different update rules

**Konjugate's solver** (explicit Euler), for a chosen step `Δt`:

```
x(t+Δt) = x(t) + rate(x(t))·Δt
```

`Δt` is explicit and free -- shrink it and the result converges to the exact solution of `dx/dt = rate(x)`.

**Causal inference's fitted rule**, scalar case, self-lag kept instead of discarded:

```
x[t+1] = coefficient · x[t]
```

No `Δt` anywhere. `coefficient` is whatever the data showed between one CSV row and the next -- specific to that one row spacing, whatever it was.

## What was shipped before this feature

The self-lag `coefficient` was discarded, and whatever cross-source coefficient remained was placed directly into the derivative:

```
dx/dt = coefficient_source · x_source        <- wrong: coefficient is a per-Δt multiplier, not a rate
```

## Approach 1: matrix logarithm -- tried, rejected

For a linear system, sampling a continuous rate `A` at fixed spacing `Δt` gives an exact discrete transition:

```
Φ = exp(A·Δt)        <=>        A = log(Φ) / Δt
```

Scalar case (one variable, its own self-lag):

```
coefficient = e^(rate·Δt)        <=>        rate = ln(coefficient) / Δt
```

This is the *mathematically exact* inverse **if the data really is a sampling of an underlying continuous linear system**. It worked dramatically well on a hand-built 2-variable system constructed exactly that way (0.34 vs. 32 final-state forward-simulation error against today's shipped approach). It failed catastrophically -- not just imprecisely -- on this project's own canonical 8-node validation system, for a reason that generalizes beyond that one system: several downstream nodes there have a genuinely *zero* true self-lag (an ordinary "derived quantity with no memory of its own" pattern, not contrived), which pushes some of the fitted transition matrix `Φ`'s eigenvalues to near-zero or clustered near 1. `log` of such a matrix is either mathematically undefined (a negative real eigenvalue has no real logarithm) or numerically explosive (repeated/clustered eigenvalues are intrinsically ill-conditioned for any matrix function) -- and critically, Eigen's `MatrixBase::log()` does **not** throw or produce NaN in either case; it silently returns a finite-looking matrix that a round-trip check (`exp(log(Φ)) ≈ Φ`) proved was not a genuine logarithm at all (off by 5+ orders of magnitude). Forward-simulated trajectory error using the recovered "rate": ~1e9, no improvement over the ~1e11 of the already-broken pre-existing approach.

The deeper issue: `Φ = exp(AΔt)` presumes the data is a sampling of *something* continuous. Causal inference imports arbitrary user CSVs, many of which are discrete or synchronous by construction (a variable computed each tick as a function of other variables' prior-tick values, with no continuous-time analogue at all) -- for those, asking "what continuous system, sampled at this Δt, produced this apparent discrete transition" doesn't have a well-posed answer, and there is no reliable way to tell from a CSV alone which kind of data you have. This is a strictly worse failure mode than the aliasing risk below: aliasing at least gives a partial detection signal (the cross-rate consistency check); this gives none.

## Approach 2: exact Euler-match ("the first-order shortcut") -- shipped

```
rate = (coefficient − 1) / Δt
```

An earlier draft of this doc called this "the first-order shortcut... exact only as `Φ → I`," on the theory that it's the first term of `log`'s own Taylor series. That framing was checked against the wrong goal. Re-derived directly from Konjugate's own solver instead of from matrix log's Taylor expansion: solving `x(t) + rate·x(t)·Δt = coefficient·x(t)` for `rate` gives exactly `rate = (coefficient − 1)/Δt` -- not an approximation to anything, but the precise answer to "what rate makes one Euler step at this Δt reproduce this fitted discrete transition." (A cross-term coefficient, with no "unchanged" baseline to subtract, transforms as `rate = coefficient/Δt` instead -- no `-1`.)

This has none of the matrix-log approach's failure modes: no matrix decomposition at all, so no branch cuts and no eigenvalue-clustering sensitivity -- entrywise arithmetic on scalar coefficients Konjugate had already fitted, always finite and well-defined. Verified on the same 8-node system that broke matrix log: forward-sim RMS error **6.4** (vs. ~1e9 for matrix log, ~1e11 for the pre-existing approach), and the Euler-reproduction identity holds to machine precision. It also generalizes to fitted polynomial (degree ≥ 2) terms cleanly, since the transform is applied per-term rather than to a joint linear-systems matrix -- something the matrix-log approach fundamentally couldn't do.

The one real limitation, and it's honest rather than silent: this rate is calibrated to *one* Euler step at the CSV's own Δt. Run Konjugate with a much finer step size and repeated application converges toward `e^(coefficient−1)·x` rather than `coefficient·x` -- a graceful drift, not a cliff, and nothing like matrix log's risk of a plausible-looking wrong answer with no error at all.

## What it would take to do better than this

Not attempted, and not currently believed necessary given the shipped approach's robustness -- but for the record: a genuinely more accurate result (matching arbitrarily fine substep refinement, not just the CSV's own Δt) would still require solving the matrix-log approach's core problem -- reliably detecting, from the data alone, whether a continuous linear system actually underlies it -- which is a different and harder question than anything resolved here.
