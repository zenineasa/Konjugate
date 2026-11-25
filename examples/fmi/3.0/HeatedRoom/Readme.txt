HeatedRoom: an FMU exported by Konjugate (https://github.com/zenineasa/Konjugate)

A room (heat capacity 1000 J/K, loss 50 W/K to 280 K outside) heated from 285 K towards a 293.15 K setpoint by a digital
PID controller sampled every 10 ms, with a noisy temperature sensor (a random stream seeded from the model, so runs repeat) and its output
limited to 0..2000 W. The controller is the C++ program examples/providers/pidController.cpp, compiled into the FMU.

FMI features it tests: FMI 3.0 Co-Simulation; a Float64 output that is continuous (the temperature) and one held between
the controller's samples (the heater power); six tunable Float64 parameters (the controller's gains and limits), with
declared units; internal discrete state (the integral, the held command, the random stream) carried in
fmi3GetFMUState/fmi3SetFMUState (canGetAndSetFMUState="true"); fmi3DoStep over a communication step of 100 internal
steps (fixedInternalStepSize 0.005 s).

Files: HeatedRoom.fmu (FMI 3.0 Co-Simulation, binaries for aarch64-darwin (aarch64) only; no source code FMU, which Konjugate
does not export), HeatedRoom_ref.csv (the Konjugate engine's own run of the same project), HeatedRoom_ref.opt.
Simulate it from 0.0 s to 60.0 s with a communication step of 0.5 s, or another whole multiple of
its internal step of 0.005 s: a step that is not one is refused (fmi3Error). The FMU has no inputs.

How it was made and checked, and how to regenerate it: examples/fmi/README.md.
