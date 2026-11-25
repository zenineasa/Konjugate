ThermalEquilibrium: an FMU exported by Konjugate (https://github.com/zenineasa/Konjugate)

A hot body (350 K) and a cold body (290 K), each a thermal mass of 1000 J/K, joined by a conductance of 50 W/K: the two
temperatures meet at 320 K with a time constant of 10 s. It is the shipped example examples/thermalEquilibrium.kjt.

FMI features it tests: FMI 2.0 Co-Simulation; two continuous outputs (the temperatures); two tunable real parameters
("conductance", "thermalCapacitance"); fmi2DoStep over a communication step of 10 internal steps (Euler, 0.1 s);
fmi2GetFMUstate/fmi2SetFMUstate and fmi2SerializeFMUstate (canGetAndSetFMUstate="true").

Files: ThermalEquilibrium.fmu (FMI 2.0 Co-Simulation, binaries for darwin64 (aarch64) only; no source code FMU, which Konjugate
does not export), ThermalEquilibrium_ref.csv (the Konjugate engine's own run of the same project), ThermalEquilibrium_ref.opt.
Simulate it from 0.0 s to 60.0 s with a communication step of 1.0 s, or another whole multiple of
its internal step of 0.1 s: a step that is not one is refused (fmi2Error). The FMU has no inputs.

How it was made and checked, and how to regenerate it: examples/fmi/README.md.
