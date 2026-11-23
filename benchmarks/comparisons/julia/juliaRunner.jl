# Copyright © 2026 Zenin Easa Panthakkalakath
#
# Julia's DifferentialEquations.jl (the OrdinaryDiffEq solver packages, versions pinned by Manifest.toml beside this file) on a comparison
# problem (benchmarks/comparisons/problems.mjs), each method over every tolerance. Three times are kept apart: loading the packages
# (LOAD_SECONDS, this process), the first solve of each method, which includes compiling it for this problem (Julia's JIT), and the solve
# itself, timed after that warm-up, each timed run preceded by the quiet gate when one is given. With the work Julia counts and the error
# against the problem's reference at its samples.
#
#   julia --project=benchmarks/comparisons/julia --startup-file=no benchmarks/comparisons/julia/juliaRunner.jl [--quiet-command "..."]
#   then commands as JSON lines on stdin, one round each (compare.mjs serves them): an untimed warm-up solve and one timed solve per tolerance
#
# The implicit methods are given the exact Jacobian (sparse for the large grids), as Konjugate's Stiff and BDF use exact Jacobians by
# default; BLAS runs on one thread, as Konjugate's serial backend does. Output is at the samples through saveat (dense interpolation).

const LOAD_STARTED = time_ns()
using OrdinaryDiffEqCore, OrdinaryDiffEqTsit5, OrdinaryDiffEqLowOrderRK, OrdinaryDiffEqRosenbrock, OrdinaryDiffEqBDF
using SciMLBase, SparseArrays, LinearAlgebra, JSON
const LOAD_SECONDS = (time_ns() - LOAD_STARTED) / 1e9
LinearAlgebra.BLAS.set_num_threads(1)

const ALGORITHMS = Dict("Tsit5" => () -> Tsit5(), "DP5" => () -> DP5(), "Rodas4" => () -> Rodas4(), "Rodas5P" => () -> Rodas5P(),
    "FBDF" => () -> FBDF(), "QNDF" => () -> QNDF())

function arguments()
    options = Dict("quiet-command" => "")
    index = 1
    while index <= length(ARGS)
        options[replace(ARGS[index], "--" => "")] = ARGS[index + 1]
        index += 2
    end
    options
end

# The problem's right-hand side, in place, and its exact Jacobian; `switch` is the buck's switch when the switching instants are given.
function problemFunction(spec, switch)
    kind = spec["kind"]
    p = spec["parameters"]
    if kind == "robertson"
        k1, k2, k3 = Float64(p["k1"]), Float64(p["k2"]), Float64(p["k3"])
        f! = (du, u, _, t) -> begin
            a, b, c = u[1], u[2], u[3]
            du[1] = -k1 * a + k3 * b * c; du[2] = k1 * a - k3 * b * c - k2 * b * b; du[3] = k2 * b * b
            nothing
        end
        jac! = (J, u, _, t) -> begin
            a, b, c = u[1], u[2], u[3]
            J[1, 1] = -k1; J[1, 2] = k3 * c; J[1, 3] = k3 * b
            J[2, 1] = k1; J[2, 2] = -k3 * c - 2 * k2 * b; J[2, 3] = -k3 * b
            J[3, 1] = 0.0; J[3, 2] = 2 * k2 * b; J[3, 3] = 0.0
            nothing
        end
        return ODEFunction(f!; jac = jac!)
    elseif kind == "vanDerPol"
        mu = Float64(p["mu"])
        f! = (du, u, _, t) -> (du[1] = u[2]; du[2] = mu * (1 - u[1]^2) * u[2] - u[1]; nothing)
        jac! = (J, u, _, t) -> (J[1, 1] = 0.0; J[1, 2] = 1.0; J[2, 1] = -2 * mu * u[1] * u[2] - 1; J[2, 2] = mu * (1 - u[1]^2); nothing)
        return ODEFunction(f!; jac = jac!)
    elseif kind == "lorenz"
        s, r, b = Float64(p["sigma"]), Float64(p["rho"]), Float64(p["beta"])
        f! = (du, u, _, t) -> (du[1] = s * (u[2] - u[1]); du[2] = u[1] * (r - u[3]) - u[2]; du[3] = u[1] * u[2] - b * u[3]; nothing)
        jac! = (J, u, _, t) -> begin
            J[1, 1] = -s; J[1, 2] = s; J[1, 3] = 0.0
            J[2, 1] = r - u[3]; J[2, 2] = -1.0; J[2, 3] = -u[1]
            J[3, 1] = u[2]; J[3, 2] = u[1]; J[3, 3] = -b
            nothing
        end
        return ODEFunction(f!; jac = jac!)
    elseif kind == "linear"
        rows = p["rows"]
        n = length(rows)
        I = Int[]; Jc = Int[]; V = Float64[]
        for (i, row) in enumerate(rows), entry in row
            push!(I, i); push!(Jc, Int(entry[1]) + 1); push!(V, Float64(entry[2]))
        end
        A = sparse(I, Jc, V, n, n)
        bvec = Float64.(p["forcing"])
        if get(spec, "sparse", false)
            f! = (du, u, _, t) -> (mul!(du, A, u); du .+= bvec; nothing)
            jac! = (J, u, _, t) -> (copyto!(nonzeros(J), nonzeros(A)); nothing)
            return ODEFunction(f!; jac = jac!, jac_prototype = copy(A))
        end
        D = Matrix(A)
        f! = (du, u, _, t) -> (mul!(du, D, u); du .+= bvec; nothing)
        jac! = (J, u, _, t) -> (copyto!(J, D); nothing)
        return ODEFunction(f!; jac = jac!)
    elseif kind == "buck"
        vin, L, C, R = Float64(p["inputVoltage"]), Float64(p["inductance"]), Float64(p["capacitance"]), Float64(p["load"])
        r = Float64(p["windingResistance"]) + Float64(p["switchResistance"])
        omega = 2pi * Float64(p["frequency"]); phase = pi * Float64(p["duty"]); threshold = cos(phase)
        sw = switch === nothing ? (t -> cos(omega * t - phase) >= threshold ? 1.0 : 0.0) : (t -> switch[])
        f! = (du, u, _, t) -> begin
            i, v = u[1], u[2]; s = sw(t)
            du[1] = (s * vin - r * i - v) / L; du[2] = (i - v / R) / C; du[3] = s * vin * i; du[4] = r * i * i; du[5] = v * v / R
            nothing
        end
        jac! = (J, u, _, t) -> begin
            fill!(J, 0.0); i, v = u[1], u[2]; s = sw(t)
            J[1, 1] = -r / L; J[1, 2] = -1 / L; J[2, 1] = 1 / C; J[2, 2] = -1 / (R * C); J[3, 1] = s * vin; J[4, 1] = 2 * r * i; J[5, 2] = 2 * v / R
            nothing
        end
        return ODEFunction(f!; jac = jac!)
    end
    error("unknown kind $(kind)")
end

function switchingEdges(spec)
    p = spec["parameters"]; period = 1 / Float64(p["frequency"]); duty = Float64(p["duty"]); finish = Float64(spec["run"]["targetTime"])
    edges = Tuple{Float64, Float64}[]
    k = 0
    while k * period < finish
        k > 0 && push!(edges, (k * period, 1.0))
        k * period + duty * period < finish && push!(edges, (k * period + duty * period, 0.0))
        k += 1
    end
    edges
end

function relativeError(sol, reference, compared)
    worst = 0.0
    for (column, state) in enumerate(compared)
        ref = [sample[column] for sample in reference]
        span = maximum(ref) - minimum(ref)
        err = maximum(abs(sol.u[k][state + 1] - ref[k]) for k in eachindex(ref))
        isfinite(err) || return Inf
        worst = max(worst, span > 0 ? err / span : (err == 0 ? 0.0 : Inf))
    end
    worst
end

function runOnce(spec, method, rtol, switching)
    times = Float64.(spec["times"])
    atol = Float64.(spec["absoluteScale"]) .* rtol
    u0 = Float64.(spec["initial"])
    options = (reltol = rtol, abstol = atol, saveat = times, maxiters = 10^9)
    if spec["kind"] == "buck" && switching == "given"
        switch = Ref(1.0)
        edges = switchingEdges(spec)
        values = Dict(edges)
        callback = DiscreteCallback((u, t, integrator) -> haskey(values, t), integrator -> (switch[] = values[integrator.t]; u_modified!(integrator, true)); save_positions = (false, false))
        problem = ODEProblem(problemFunction(spec, switch), u0, (times[1], times[end]))
        return solve(problem, ALGORITHMS[method](); options..., tstops = first.(edges), callback = callback)
    end
    problem = ODEProblem(problemFunction(spec, nothing), u0, (times[1], times[end]))
    solve(problem, ALGORITHMS[method](); options...)
end

function measure(spec, method, switching, quiet, skip, firstSeen)
    reference = spec["reference"]["samples"]
    records = Any[]
    overBudget = false
    for rtol in Float64.(spec["tolerances"])
        (rtol in skip || overBudget) && continue
        record = Dict{String, Any}("tool" => "Julia", "method" => method, "tolerance" => rtol, "switching" => switching)
        try
            warm = @elapsed sol = runOnce(spec, method, rtol, switching)
            SciMLBase.successful_retcode(sol) || error("solver stopped: $(sol.retcode)")
            key = (spec["id"], method, switching, rtol)
            if !haskey(firstSeen, key)
                firstSeen[key] = warm
                record["firstSolveSeconds"] = warm
            end
            isempty(quiet) || run(Cmd(String.(split(quiet))))
            timed = @elapsed sol = runOnce(spec, method, rtol, switching)
            stats = sol.stats
            record["ok"] = true; record["solveSeconds"] = [timed]
            record["work"] = Dict("nfev" => stats.nf, "njev" => stats.njacs, "nlu" => stats.nw, "steps" => stats.naccept, "rejected" => stats.nreject)
            record["relativeError"] = relativeError(sol, reference, spec["compared"])
            overBudget = timed > 120
        catch failure
            record["ok"] = false; record["error"] = first(sprint(showerror, failure), 300)
        end
        push!(records, record)
        println(stderr, "  Julia $(method) $(spec["id"]) rtol $(rtol): ", record["ok"] ? "$(round(1e3 * record["solveSeconds"][1]; sigdigits = 4)) ms, error $(record["relativeError"])" : record["error"])
    end
    records
end

# --serve: one command per line on stdin, {"spec": path, "method", "switching", "skip": [tolerances]}; one line of JSON back per command.
function main()
    options = arguments()
    quiet = options["quiet-command"]
    versions = Dict("julia" => string(VERSION), "packages" => Dict(string(name) => string(pkgversion(m)) for (name, m) in
        ((:OrdinaryDiffEqCore, OrdinaryDiffEqCore), (:OrdinaryDiffEqTsit5, OrdinaryDiffEqTsit5), (:OrdinaryDiffEqLowOrderRK, OrdinaryDiffEqLowOrderRK),
         (:OrdinaryDiffEqRosenbrock, OrdinaryDiffEqRosenbrock), (:OrdinaryDiffEqBDF, OrdinaryDiffEqBDF), (:SciMLBase, SciMLBase))))
    println(JSON.json(Dict("ready" => true, "versions" => versions, "loadSeconds" => LOAD_SECONDS)))
    flush(stdout)
    specs = Dict{String, Any}()
    firstSeen = Dict{Any, Float64}()
    for line in eachline(stdin)
        command = JSON.parse(line)
        path = command["spec"]
        haskey(specs, path) || (specs[path] = JSON.parse(read(path, String)))
        skip = Set(Float64.(get(command, "skip", Any[])))
        records = measure(specs[path], command["method"], get(command, "switching", "written"), quiet, skip, firstSeen)
        println(JSON.json(Dict("records" => records)))
        flush(stdout)
    end
end

main()
