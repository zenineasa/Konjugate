<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Causal inference

Given a CSV of multivariate time-series data -- a numeric, strictly increasing, evenly spaced time column, then one numeric column per variable -- the engine's `infer` command (`engine/include/causalInference.hpp`, `engine/src/causalInference.cpp`) proposes a set of candidate directed edges: which columns appear to influence which, and by how much. The renderer reviews these candidates and, on commit, materializes the accepted ones as real nodes and edges through the same operation-based pipeline the AI assistant uses (`src/assistantOperations.mjs`). This document is the mathematics behind that inference step; see [Causal inference (proposal)](proposals/causalInference.md) for the design discussion that led here, and [Project schema](projectSchema.md)/[Engine CLI contract](engineCli.md) for the surrounding data shapes.

"Causal inference" is the name throughout -- Granger causality, the technique this is built on, is literally named for the weak-but-real causal claim a lagged predictive relationship supports. The one deliberate exception is `src/csvImport.mjs`: it's a generic, reusable CSV parser and column mapper, explicitly meant to also serve the (not yet built) digital-twin CSV importer described in the proposal doc below, so it keeps a name describing what it does rather than which feature currently calls it.

The engine has no knowledge of Konjugate's node/edge model at all here -- it reasons purely about CSV columns and numbers, the same separation `inspect`/`validate` keep from the graph they check. Everything below operates on that column-and-number level; a candidate only becomes a real edge once the renderer resolves its column names to concrete node states.

## Standardization

Every variable column is standardized to zero mean and unit sample variance before anything else runs: for column *k* with values `x₁,…,x_T`, `μₖ = mean(x)` and `σₖ² = Σ(xᵢ−μₖ)² / (T−1)`, giving `x_std = (x−μₖ)/σₖ`. This keeps the skeleton threshold, the ridge penalty and the coefficient threshold all working in comparable units regardless of what physical units the source columns happen to be in -- without it, a column with naturally larger magnitude would dominate both the correlation and the regression purely from scale, not from any real relationship. `μ` and `σ` for every column are kept, since every coefficient reported at the end is converted back out of standardized units before it reaches a candidate edge.

## Stage 1: a lagged partial-correlation skeleton

Stage 1 decides which unordered pairs of columns are related at all, cheaply, before anything lag-based runs. `computePartialCorrelation(X)` is a generic building block: given any standardized matrix, the sample correlation matrix is `Σ = XᵀX / (T−1)` (already the correlation matrix, since every column has unit variance), the precision matrix is its inverse `Θ = Σ⁻¹`, and the partial correlation between columns *i* and *j* is

```
π_ij = −θ_ij / sqrt(θ_ii · θ_jj)
```

-- the standard Gaussian-graphical-model quantity: the correlation between *i* and *j* left over once every other column is conditioned out, which is what makes it a *skeleton* signal rather than raw pairwise correlation (two columns that are only related through a third would show high raw correlation but a near-zero partial correlation).

**What stage 1 feeds that function is a lag-1, not contemporaneous, matrix.** `standardized.values` is split into a "current" block (rows `1..T−1`) and a "previous" block (rows `0..T−2`), stacked side by side into one `(T−1) × 2p` matrix, and `computePartialCorrelation` runs on that combined matrix — conditioning on every other *current and lagged* column at once. An unordered pair `(i, j)` survives stage 1 if either directed lag-1 partial correlation clears `InferenceConfig::skeletonThreshold` (default `0.1`): `|π(current_j, lag_i)| ≥ threshold` or `|π(current_i, lag_j)| ≥ threshold`. This is `"partialCorrelation"`, the only skeleton method implemented in v1/v2; `InferenceConfig::skeletonMethod` is a validated string specifically so a second method is a new case later, not a schema change.

This wasn't the original design — v1 shipped screening on the *contemporaneous* (same-timestep) partial correlation of `standardized.values` directly, reusing it again as the coefficient source for the fallback tier below. That contemporaneous matrix (still computed, still used only for the fallback tier) is a reasonable-looking proxy on a small toy graph, where it happened to agree with the lagged structure closely enough that every existing v1/v2 test passed. It stopped agreeing once graphs got larger and more connected: building a real 8-node synthetic system with known ground truth (see the causal-inference blog post) found true lag-1 edges with a contemporaneous partial correlation near zero (wrongly pruned before stage 2 ever ran) and unrelated pairs with a misleadingly large one, purely from sharing an AR-driven persistence pattern with no genuine lagged relationship (wrongly admitted). Switching stage 1 to the lag-1 matrix above fixed both failure modes on that system without changing any existing test's expected result.

Screening on a lag-1 matrix doubles the column count `computePartialCorrelation` inverts (`2p` instead of `p`), so it needs more rows relative to variable count than the contemporaneous version did (`2p + 2` rather than `p + 2`) — a real cost for very wide, short datasets, not yet hit by anything in the existing test suite.

**A remaining, known limitation, deliberately not fixed:** conditioning on *every* other variable at once — including a target's own near-deterministic descendants — is a classic graphical-model pitfall (collider bias). A downstream node whose only meaningful noise is what its own parents contribute (an R² near 1 against them) acts as a proxy for its parent when that parent's *own* ancestors' skeleton signal is being tested, and can suppress it even at large sample sizes. `engine/tests/causalInferenceTests.cpp`'s and `tests/interactionRunner.mjs`'s synthetic constructions route around this by giving every downstream node genuine intrinsic noise; a real dataset with a near-noiseless derived column could still hit it.

An adaptive, PC-algorithm-style conditioning-set search (test increasing-size subsets of the *other* variables, stop the moment some subset shows independence, rather than always conditioning on literally everything) looks like the obvious fix, and was prototyped specifically to check. It was rejected after prototyping, not for lack of trying: a magnitude-threshold version wrongly pruned edges the current skeleton already gets right, and a corrected version using proper Fisher z-transform significance testing (the standard fix for that specific failure, and confirmed to actually work for it) still failed for a different, more fundamental reason -- small-subset partial correlation is not numerically robust when the conditioning set contains a variable that's near-collinear with the one under test. On the same 8-node prototype system, conditioning one variable on just its own near-perfect proxy (a second variable driven almost entirely by the first) collapsed a genuinely strong relationship (partial correlation 0.92) to numerical noise (0.03) via an ill-conditioned matrix inversion -- and correlated-but-distinct measurements of a related physical quantity are exactly the shape of real sensor/monitoring data this feature targets, not just a contrived synthetic case. Conditioning on everything at once, today's approach, doesn't hit this failure mode for the same pair, so the full-conditioning design is the more conservative choice even though it has the collider-bias blind spot described above. A safe adaptive search would need real additional work -- at minimum a numerical-stability check (e.g. a condition-number guard) before trusting any small-subset result -- and is not implemented.

## Stage 2: lagged ridge regression, per target

For each column acting as a target *i*, `sources(i)` is the set of columns that survived stage 1 against *i*. If it's empty, *i* gets no lagged candidates at all. Otherwise, every source in `sources(i)` is fit **jointly** against target *i*, along with target *i*'s own previous value as a control term -- the *self-lag* -- so that a source's correlation with the target's own persistence is never mistaken for the source's own effect. For a candidate lag `L`, degree `d` (`InferenceConfig::candidateDegrees`, default `{1}` -- see "Additive polynomial terms" below) and row `t`, the feature row is `[x_j(t−L), x_j(t−L)², …, x_j(t−L)^d for j in sources(i)] ++ [x_i(t−L)]` and the response is `x_i(t)`, all in standardized units. The self-lag control term is always linear only, regardless of `d`: its job is absorbing the target's own persistence as a nuisance variable, not something reported as an edge, and giving it its own polynomial expansion would risk it soaking up variance that should go to genuine source relationships for no benefit.

Discarding the self-lag here is also why a model built from causal inference and then actually run forward in Konjugate has no damping term on any recovered node -- every edge contributes to a *derivative* ([Project schema](projectSchema.md)), and a discrete lag-1 coefficient is not a derivative. [Causal inference (proposal)](proposals/causalInference.md)'s "Continuous time" section has the full investigation into fixing this (a matrix-exponential/logarithm conversion, prototyped and found to work well for non-oscillatory relationships but to have a real, silent-failure aliasing risk for oscillatory ones) -- not implemented.

### Ridge with an unpenalized intercept

Fitting is ordinary ridge on the centered design matrix, with the intercept recovered separately so the L2 penalty never shrinks the baseline term:

```
x̄ = colMean(X_train),  ȳ = mean(y_train)
Xc = X_train − x̄,      yc = y_train − ȳ
β  = (XcᵀXc + λI)⁻¹ Xcᵀyc
β₀ = ȳ − x̄·β
```

`(XcᵀXc + λI)` is always symmetric positive definite for `λ > 0`, solved via `Eigen::LDLT`. This matters here specifically because a chronological train split is not itself exactly zero-mean, even though the full series was standardized to be -- centering only the training rows, not relying on the whole-series standardization alone, is what keeps the fit correct on that subset.

### Additive polynomial terms (v2)

`InferenceConfig::candidateDegrees` controls whether, and how far, curvature is allowed: `{1}` (the default) is linear only, `{N}` forces degree `N` with no linear comparison, and `{1, N}` lets the fit pick whichever of linear or degree-`N` scores better per target -- the array *is* the UI's three-way choice ("Linear only" / "Allow curvature up to degree *N*" / "Let the tool decide, up to degree *N*"). The model stays **additive**: each source expands into its own power basis (`x, x², …, x^d`) with no cross terms between different sources or between a source's own degrees, so the fit is still an ordinary ridge solve against a wider feature matrix, not a new class of solver.

Degree 1 reuses the mean+scale standardized column exactly as above -- this is what keeps `candidateDegrees == {1}` byte-identical to the original linear-only behavior. Degree ≥ 2 features use a *different*, scale-only normalization instead: `v = x/σ_source` (no mean subtraction -- cheaply recovered from the mean-centered standardized column as `v = x_std + μ_source/σ_source`), then `v^p`, then divided by a per-power scalar `s_p` (the RMS of `v^p` over the training rows) purely so the ridge penalty treats every degree fairly -- a raw `v²`'s natural scale differs substantially from `v¹`'s even when `v` itself is unit-scale.

The reason for the split is destandardization. A mean-centered `x_std = (x−μ)/σ` raised to a power `p` spreads into *every* degree `0..p` of `x` once expanded (binomial expansion) -- real algebra, but complexity this design has no need for. Because scale-only `v` was never mean-centered, `v^p = x^p/σ^p` stays a single clean term with no cross-degree mixing, so recovering the original-units coefficient for a degree-`p` term is one division:

```
coefficient_p = w_p · σ_target / (σ_source^p · s_p)
```

with **no intercept correction** -- only the mean-centered degree-1 term needs one, exactly as in the linear case above. `fitRidgeRegression` needs no changes to support any of this: it already centers whatever `x`/`y` it is given internally, per call, so a design matrix mixing a mean-centered degree-1 column with non-mean-centered degree-≥2 columns is already handled correctly by its existing internal centering step.

The stage 1 skeleton pass stays linear-correlation-based even when polynomial degrees are enabled -- a purely nonlinear relationship with near-zero *linear* correlation could in principle be filtered out before stage 2 ever gets a chance to fit a polynomial to it. A nonlinear-aware skeleton (e.g. mutual information) would close this gap but is not implemented; it is a known boundary, not a solved one.

### Choosing the lag, degree and penalty by held-out score, not in-sample fit

Each candidate lag (`InferenceConfig::candidateLags`, default `1,2,3`) is split chronologically into a training prefix and a validation suffix (`InferenceConfig::validationFraction`, default `0.2`) -- never shuffled, since shuffling would leak future information into the fit exactly the way it would for any time series. For every `(lag, degree, λ)` combination (`λ` from `InferenceConfig::ridgePenalties`, default `0.01, 0.1, 1.0, 10.0`), the raw score is

```
rawScore = 1 − MSE(validation) / Var(validation target)
```

-- a held-out variance-explained measure, unbounded below but capped at `1` for a perfect fit. This is the same reasoning the design proposal gives for preferring a predictive/held-out criterion (AIC/cross-validation family) over a structure-recovery one (BIC family): the resulting graph is meant to be run forward as a simulation, so a criterion that rewards genuinely predictive relationships is the right one, not one that rewards recovering some assumed "true" sparse structure.

**Selecting the best `(lag, degree, λ)` and gating whether the result is kept at all both use a degrees-of-freedom-adjusted score instead of the raw one**, the classical adjusted-R² correction:

```
adjustedScore = 1 − (1 − rawScore) · (n−1) / (n−p−1)
```

for `n` validation rows and `p` features (source columns × degree, plus the self-lag). Everything downstream -- the score gate, the reported `edge.score` -- otherwise works exactly as the raw-score version described next; only *which* score decides the winning combination and whether it clears zero has changed. This exists because of a concrete failure mode found while extending the fit to degree ≥ 2: a richer feature set gives ridge's inevitable shrinkage of the self-lag coefficient more room to leave a residual that an unrelated but informative source (one whose own lag happens to correlate with an *earlier* lag of the target, e.g. because the target is itself autoregressive) can fit, producing a spurious reverse edge with a positive raw score that a plain `rawScore ≤ 0` gate does not catch -- and, being a shrinkage-bias effect rather than pure finite-sample noise, one that does not reliably vanish with more rows either. The adjustment shrinks toward the raw score as the validation split grows relative to the feature count (so a degree-1 fit, with few parameters, is barely affected -- this is why `candidateDegrees == {1}`'s selected fit is unchanged from v1) and toward `−∞` as the feature count approaches the validation split size, holding a degree ≥ 2 fit on a modest sample to a meaningfully higher bar. `edge.score`, as reported on the resulting candidate, is still the **raw**, more readable held-out score of whichever fit won under the adjusted comparison -- the adjustment is a selection and gating tool, not a user-facing number.

**A fit whose adjusted score is at or below zero is discarded entirely** -- every coefficient from it, no matter how large any individual one looks, since a non-positive adjusted score means the joint fit does not beat predicting the target's own held-out mean by more than its own parameter count would explain by chance. Thresholding coefficient magnitude alone does not catch this; requiring the fit to actually explain held-out variance, judged against its own complexity, does.

### From a surviving fit to a candidate edge

For a fit that passes the score gate, each source *j* is kept as a directed edge `j → i` based on the **aggregate** magnitude across all of its fitted degrees, not each one individually -- a curved relationship is one edge with a multi-term equation, not independent per-degree decisions (mirroring the reference prototype's own `edge_scores()`, an L2 norm across a source's degree block). Writing `β_{j,p}` for source *j*'s standardized coefficient at degree `p` (`p` ranging over whatever `bestDegree` the winning fit used):

```
aggregate_j = sqrt(Σ_p β_{j,p}²)
```

*j* is accepted only if `aggregate_j ≥ InferenceConfig::coefficientThreshold` (default `0.05`). Each accepted degree then de-standardizes independently -- degree 1 exactly as before, degree ≥ 2 via the scale-only formula above:

```
coefficient_{j,1} = β_{j,1} · σ_i / σ_j                              (degree 1)
coefficient_{j,p} = β_{j,p} · σ_i / (σ_j^p · s_p)          (degree p ≥ 2)
```

producing one `{degree, coefficient}` term per fitted degree on the edge (`InferredEdge::terms`), rather than the single scalar coefficient v1 shipped. The joint intercept is de-standardized the same way as before and then split evenly across every accepted source's **degree-1 term only** for that target (degree ≥ 2 terms contribute no intercept correction, per the derivation above), so the accepted degree-1 terms' share of it still sums to the full de-standardized intercept exactly -- consistent with how Konjugate already sums every edge's own contribution into a node's derivative ([Project schema](projectSchema.md): "Multiple relationships targeting the same state contribute additively"). The self-lag's own coefficient is discarded once it has served its purpose as a control term; it never becomes part of any edge.

## The fallback tier: correlation without a direction

A pair that survives stage 1 but has no lagged evidence in either direction (neither `i → j` nor `j → i` clears the score gate and coefficient threshold) is not dropped. It still produces two directed edges -- one each way -- built from the shared, symmetric *contemporaneous* partial-correlation coefficient `π_ij` (not the lag-1 matrix stage 1 screens with) instead of a lagged one, de-standardized with the same degree-1 formula (`π_ij · σ_target/σ_source`) as a single-term `terms = [{degree: 1, coefficient: …}]`, tagged `provenance = "correlationOnly"` rather than `"lagged"`. This tier is always linear (degree 1) regardless of `candidateDegrees` -- it is built from partial correlation, an inherently linear measure, so there is no natural nonlinear counterpart to it here.

This mirrors a decision already made for [edge groups](edgeGroups.md): a mutual relationship is represented as two independent directed edges, never a single bidirectional one, since a bidirectional edge's engine-level sign-flip is only correct for an anti-symmetric relationship, which a fitted (or correlation-derived) coefficient has no reason to be -- see [Edge and relationship directionality](edgeDirectionality.md). The provenance tag is what keeps this case visibly distinct from a lagged pair in the review UI: "these move together, direction unclear" should never look identical to "these drive each other."

## From a candidate to a real equation

The renderer resolves `sourceColumn`/`targetColumn` to concrete node states (existing, matched by exact symbol/name, or newly created) and generates LaTeX text for the accepted candidate -- not a hand-built `mathJson` tree, since `validateEquationLatex`/`ComputeEngine` already parses programmatically-interpolated numeric literals (decimals, negatives, scientific notation) with no special-casing needed. The source symbol is always `reconcileEquationBindings`'s own auto-generated role-prefixed name (e.g. `sourceTemperature`), wrapped in `\mathrm{}` -- any multi-letter LaTeX symbol needs this wrapping to parse as one token rather than implicit multiplication of single-letter variables, regardless of whether it happens to trip the separate single-letter `_upright` quirk `\mathrm{}` also avoids. `Power` is already a supported `mathJson` primitive, so a degree ≥ 2 term needs no equation-engine changes either: it renders as `sourceX^{degree}`, degree 1 as the bare symbol. The generated equation is `coefficient₁ · sourceX ± coefficient₂ · sourceX² ± … ± intercept`, one term per entry in `InferredEdge::terms`, submitted as one `addEdge` + `setEdgeEquation` operation pair (plus `addNode`/`addState` operations for any column with no existing match) through the same `applyAssistantProposal` → native-`validate` → `replaceModelContents` pipeline the AI assistant already uses, so the import lands as one undoable step with the same validation guarantees as any other model edit.

## Continuous-time mode (optional)

Every discrete coefficient described above is a per-Δt multiplier (`target[t] = coefficient · source[t-1] + …`), not a continuous rate -- placed directly into Konjugate's `dx/dt = coefficient · source` as v1 did, it's a real unit mismatch. Checking "Fit for continuous-time simulation (experimental)" in the import dialog fixes this by transforming every fitted coefficient into a rate before it ever becomes an edge equation.

The transform is `rate = coefficient / Δt` for a cross-term (any degree) and `rate = (selfLagCoefficient − 1) / Δt` for a target's own self-lag -- the exact (not approximate) solution to "what rate makes one Euler step at the CSV's own sampling interval reproduce this fitted discrete transition." Konjugate's solver already integrates the equation `dx/dt = A · x` via `x(t+Δt) = x(t) + A·x(t)·Δt`, so setting `1 + rate·Δt = coefficient` and solving for `rate` is a one-line derivation, not a numerical technique -- unlike an earlier, rejected approach (`A = log(Φ)/Δt`, the matrix-exponential/logarithm correspondence for linear systems; see [Discrete fit vs. continuous rate](proposals/continuousTimeConversion.md) and the proposal doc's "Continuous time" section for the full investigation, including *why* it was tried first and *why* it failed catastrophically on this project's own 8-node validation system). Because this transform is entrywise arithmetic, not a matrix decomposition, it has none of that approach's failure modes, and -- a genuine bonus, not just a fix -- it applies cleanly to every fitted polynomial degree, so continuous-time mode has no need to restrict itself to linear-only fits the way the rejected approach did.

Two consequences follow directly from the derivation:

- **`candidateLags` must be exactly `{1}`.** A predictor from 2+ CSV rows back has no single-Euler-step interpretation (that would need an explicit delay buffer, out of scope). `inferGraph()` throws rather than silently ignoring a wider lag set.
- **The self-lag becomes a real, kept quantity** instead of the discarded control term described above -- and since Konjugate's schema has no such thing as an edge from a node to itself (`addEdge` rejects `source === target`), it's emitted as a `SelfTerm { targetColumn, rate }` and committed as an `addSourceTerm` operation on the target's own state (see [Project schema](projectSchema.md)'s `sourceTerms`), not an edge. `provenance` is `"continuousLagged"` for a cross-term in this mode, distinct from `"lagged"`, so a continuous-rate edge can never be silently confused with a discrete-coefficient one in the same `terms[].coefficient` field. `correlationOnly` fallback edges are unaffected -- partial correlation has no natural continuous-rate counterpart.

One honest limitation, surfaced in the import dialog itself: the recovered rate is calibrated to a single Euler step at the CSV's own Δt. Running Konjugate with a much finer step size than that doesn't fail outright, but drifts -- repeated application converges toward `e^(coefficient−1)·x` rather than `coefficient·x`, a graceful degradation rather than the silent, unbounded wrong-answer risk the matrix-log approach carried.
