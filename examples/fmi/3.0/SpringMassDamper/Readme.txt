SpringMassDamper: an FMU exported by Konjugate (https://github.com/zenineasa/Konjugate)

A 1 kg mass on a spring (4 N/m) and a damper (0.4 N*s/m) to a fixed support, released from 0.1 m: a damped oscillation of
period about 3.2 s. It is the shipped example examples/springMassDamper.kjt. The mass is integrated in four substeps of each
0.01 s step.

FMI features it tests: FMI 3.0 Co-Simulation; four continuous Float64 outputs (displacement and velocity of the mass and
of the support); tunable Float64 parameters, with declared units; the independent variable "time"; fmi3DoStep over a
communication step of 5 internal steps (fixedInternalStepSize 0.01 s); a node integrated in substeps inside each step;
fmi3GetFMUState/fmi3SetFMUState (canGetAndSetFMUState="true").

Files: SpringMassDamper.fmu (FMI 3.0 Co-Simulation, binaries for aarch64-darwin (aarch64) only; no source code FMU, which Konjugate
does not export), SpringMassDamper_ref.csv (the Konjugate engine's own run of the same project), SpringMassDamper_ref.opt.
Simulate it from 0.0 s to 10.0 s with a communication step of 0.05 s, or another whole multiple of
its internal step of 0.01 s: a step that is not one is refused (fmi3Error). The FMU has no inputs.

How it was made and checked, and how to regenerate it: examples/fmi/README.md.
