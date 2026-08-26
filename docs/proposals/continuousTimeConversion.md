<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Discrete fit vs. continuous rate: the math, side by side

Companion note to [Causal inference (proposal)](causalInference.md)'s "Continuous time" section -- equations only, minimally explained. Not shipped; nothing here is implemented.

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

## What's shipped today

The self-lag `coefficient` is discarded, and whatever cross-source coefficient remains is placed directly into the derivative:

```
dx/dt = coefficient_source · x_source        <- wrong: coefficient is a per-Δt multiplier, not a rate
```

## The exact relationship between them

For a linear system, sampling a continuous rate `A` at fixed spacing `Δt` gives an exact discrete transition:

```
Φ = exp(A·Δt)        <=>        A = log(Φ) / Δt
```

Scalar case (one variable, its own self-lag):

```
coefficient = e^(rate·Δt)        <=>        rate = ln(coefficient) / Δt
```

## The first-order shortcut (checked, not recommended)

```
rate ≈ (coefficient − 1) / Δt
```

This is `log(Φ) ≈ Φ − I`, the first term of the log's own Taylor series -- exact only as `Φ → I` (barely any change per sample). Reproduces the fitted behavior at exactly that one `Δt`, but doesn't converge to anything as the solver's own step size is refined away from it, unlike `log(Φ)/Δt`. Empirically: recovers a visibly worse `A` (Frobenius error ~34x larger in the tested case) than the exact log, though the two happened to forward-simulate to a similar trajectory error in that specific, mild, non-oscillatory test -- not a general guarantee.

## What it would take to actually match them

- Keep every target's self-lag coefficient instead of discarding it -- it's the diagonal of `Φ`/`A`, not a nuisance term.
- Fit `Φ` as one joint matrix across all targets at once, not per-target independent regressions -- `A = log(Φ)/Δt` needs the whole matrix, not one row at a time.
- A numerically robust matrix logarithm (naive eigendecomposition breaks on near-repeated and on complex eigenvalues -- see the proposal doc's findings for both).
- A way to know when `log(Φ)` isn't trustworthy at all: an oscillatory relationship sampled too slowly relative to its true frequency recovers a *different, wrong* `A`, not just a noisier one (aliasing) -- see the proposal doc for how the obvious detector for this (cross-rate consistency) fails specifically at the worst under-sampling.
