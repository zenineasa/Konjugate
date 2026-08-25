<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Time-series graph inference

Given a CSV of multivariate time-series data -- a numeric, strictly increasing, evenly spaced time column, then one numeric column per variable -- the engine's `infer` command (`engine/include/graphInference.hpp`, `engine/src/graphInference.cpp`) proposes a set of candidate directed edges: which columns appear to influence which, and by how much. The renderer reviews these candidates and, on commit, materializes the accepted ones as real nodes and edges through the same operation-based pipeline the AI assistant uses (`src/assistantOperations.mjs`). This document is the mathematics behind that inference step; see [Time-series graph inference (proposal)](proposals/timeSeriesGraphInference.md) for the design discussion that led here, and [Project schema](projectSchema.md)/[Engine CLI contract](engineCli.md) for the surrounding data shapes.

The engine has no knowledge of Konjugate's node/edge model at all here -- it reasons purely about CSV columns and numbers, the same separation `inspect`/`validate` keep from the graph they check. Everything below operates on that column-and-number level; a candidate only becomes a real edge once the renderer resolves its column names to concrete node states.

## Standardization

Every variable column is standardized to zero mean and unit sample variance before anything else runs: for column *k* with values `x₁,…,x_T`, `μₖ = mean(x)` and `σₖ² = Σ(xᵢ−μₖ)² / (T−1)`, giving `x_std = (x−μₖ)/σₖ`. This keeps the skeleton threshold, the ridge penalty and the coefficient threshold all working in comparable units regardless of what physical units the source columns happen to be in -- without it, a column with naturally larger magnitude would dominate both the correlation and the regression purely from scale, not from any real relationship. `μ` and `σ` for every column are kept, since every coefficient reported at the end is converted back out of standardized units before it reaches a candidate edge.

## Stage 1: a partial-correlation skeleton

Stage 1 decides which unordered pairs of columns are related at all, cheaply, before anything lag-based runs. On the standardized data, the sample correlation matrix is `Σ = XᵀX / (T−1)` (already the correlation matrix, since every column has unit variance), and the precision matrix is its inverse, `Θ = Σ⁻¹`. The partial correlation between columns *i* and *j* is

```
π_ij = −θ_ij / sqrt(θ_ii · θ_jj)
```

-- the standard Gaussian-graphical-model quantity: the correlation between *i* and *j* left over once every other column is conditioned out, which is what makes it a *skeleton* signal rather than raw pairwise correlation (two columns that are only related through a third would show high raw correlation but a near-zero partial correlation). A pair survives stage 1 when `|π_ij|` clears `InferenceConfig::skeletonThreshold` (default `0.1`). This is `"partialCorrelation"`, the only skeleton method implemented in v1; `InferenceConfig::skeletonMethod` is a validated string specifically so a second method is a new case later, not a schema change. Computing `Θ` requires more rows than columns (`computePartialCorrelation` requires at least `columns + 2` rows), since the correlation matrix is not reliably invertible below that.

## Stage 2: lagged ridge regression, per target

For each column acting as a target *i*, `sources(i)` is the set of columns that survived stage 1 against *i*. If it's empty, *i* gets no lagged candidates at all. Otherwise, every source in `sources(i)` is fit **jointly** against target *i*, along with target *i*'s own previous value as a control term -- the *self-lag* -- so that a source's correlation with the target's own persistence is never mistaken for the source's own effect. For a candidate lag `L` and row `t`, the feature row is `[x_j(t−L) for j in sources(i)] ++ [x_i(t−L)]` and the response is `x_i(t)`, all in standardized units.

### Ridge with an unpenalized intercept

Fitting is ordinary ridge on the centered design matrix, with the intercept recovered separately so the L2 penalty never shrinks the baseline term:

```
x̄ = colMean(X_train),  ȳ = mean(y_train)
Xc = X_train − x̄,      yc = y_train − ȳ
β  = (XcᵀXc + λI)⁻¹ Xcᵀyc
β₀ = ȳ − x̄·β
```

`(XcᵀXc + λI)` is always symmetric positive definite for `λ > 0`, solved via `Eigen::LDLT`. This matters here specifically because a chronological train split is not itself exactly zero-mean, even though the full series was standardized to be -- centering only the training rows, not relying on the whole-series standardization alone, is what keeps the fit correct on that subset.

### Choosing the lag and penalty by held-out score, not in-sample fit

Each candidate lag (`InferenceConfig::candidateLags`, default `1,2,3`) is split chronologically into a training prefix and a validation suffix (`InferenceConfig::validationFraction`, default `0.2`) -- never shuffled, since shuffling would leak future information into the fit exactly the way it would for any time series. For every `(lag, λ)` pair (`λ` from `InferenceConfig::ridgePenalties`, default `0.01, 0.1, 1.0, 10.0`), the score is

```
score = 1 − MSE(validation) / Var(validation target)
```

-- a held-out variance-explained measure, unbounded below but capped at `1` for a perfect fit. This is the same reasoning the design proposal gives for preferring a predictive/held-out criterion (AIC/cross-validation family) over a structure-recovery one (BIC family): the resulting graph is meant to be run forward as a simulation, so a criterion that rewards genuinely predictive relationships is the right one, not one that rewards recovering some assumed "true" sparse structure. The `(lag, λ)` combination with the best score across the whole search is kept as that target's fit.

**A fit that scores at or below zero is discarded entirely** -- every coefficient from it, no matter how large any individual one looks, since a non-positive score means the joint fit does not even beat predicting the target's own held-out mean. This gate exists because of a concrete failure mode found while testing it: a target whose own dynamics are already well explained by its self-lag term can still show a small but nonzero standardized coefficient on an unrelated source, purely from finite-sample overfitting under a weak ridge penalty, even though the joint fit is clearly worse than the null model. Thresholding coefficient magnitude alone does not catch this; requiring the fit to actually explain held-out variance does.

### From a surviving coefficient to a candidate edge

For a fit that passes the score gate, each source *j*'s own standardized coefficient `β_j` is kept as a directed edge `j → i` only if `|β_j| ≥ InferenceConfig::coefficientThreshold` (default `0.05`). Its coefficient is de-standardized back to the original units of the two columns:

```
coefficient = β_j · σ_i / σ_j
```

The joint intercept is de-standardized the same way and then split evenly across every accepted source for that target, so their sum reconstructs the full de-standardized intercept exactly (this is what makes the split well-defined regardless of how many of the target's sources end up accepted) -- consistent with how Konjugate already sums every edge's own contribution into a node's derivative ([Project schema](projectSchema.md): "Multiple relationships targeting the same state contribute additively"). The self-lag's own coefficient is discarded once it has served its purpose as a control term; it never becomes part of any edge.

## The fallback tier: correlation without a direction

A pair that survives stage 1 but has no lagged evidence in either direction (neither `i → j` nor `j → i` clears the score gate and coefficient threshold) is not dropped. It still produces two directed edges -- one each way -- built from the shared, symmetric partial-correlation coefficient `π_ij` instead of a lagged one, de-standardized with the same formula (`π_ij · σ_target/σ_source`), tagged `provenance = "correlationOnly"` rather than `"lagged"`.

This mirrors a decision already made for [edge groups](edgeGroups.md): a mutual relationship is represented as two independent directed edges, never a single bidirectional one, since a bidirectional edge's engine-level sign-flip is only correct for an anti-symmetric relationship, which a fitted (or correlation-derived) coefficient has no reason to be -- see [Edge and relationship directionality](edgeDirectionality.md). The provenance tag is what keeps this case visibly distinct from a lagged pair in the review UI: "these move together, direction unclear" should never look identical to "these drive each other."

## From a candidate to a real equation

The renderer resolves `sourceColumn`/`targetColumn` to concrete node states (existing, matched by exact symbol/name, or newly created) and generates LaTeX text for the accepted candidate -- not a hand-built `mathJson` tree, since `validateEquationLatex`/`ComputeEngine` already parses programmatically-interpolated numeric literals (decimals, negatives, scientific notation) with no special-casing needed. The source symbol is always `reconcileEquationBindings`'s own auto-generated role-prefixed name (e.g. `sourceTemperature`), which is multi-letter by construction and so never trips the `\mathrm{}` single-letter `_upright` parsing quirk. The generated equation is exactly `coefficient · sourceX ± intercept`, submitted as one `addEdge` + `setEdgeEquation` operation pair (plus `addNode`/`addState` operations for any column with no existing match) through the same `applyAssistantProposal` → native-`validate` → `replaceModelContents` pipeline the AI assistant already uses, so the import lands as one undoable step with the same validation guarantees as any other model edit.
