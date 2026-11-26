// Copyright © 2026 Zenin Easa Panthakkalakath
// A PI controller for a heated room, drawn from the Modelica Standard Library's blocks (Modelica.Blocks.Continuous.LimPID),
// exported as a Co-Simulation FMU by examples/pidController/generate.mjs. See README.md beside it.
within ;
model PidController "PI controller for a heated room, from the Modelica Standard Library's LimPID: setpoint and measurement in, heater command (0 to 1) out"
  parameter Real k(unit = "1/K") = 0.5 "Gain: heater command per kelvin of error";
  parameter Modelica.Units.SI.Time Ti = 600 "Integral time";
  parameter Real yMax(unit = "1") = 1 "Largest heater command";
  parameter Real yMin(unit = "1") = 0 "Smallest heater command";
  Modelica.Blocks.Interfaces.RealInput setpoint(unit = "degC") "Wanted room temperature";
  Modelica.Blocks.Interfaces.RealInput measurement(unit = "degC") "Measured room temperature";
  Modelica.Blocks.Interfaces.RealOutput command(unit = "1") "Heater command, from 0 (off) to 1 (full power)";
protected
  // Protected, so its own parameters stay inside the FMU (exported with --fmiFilter=protected): the FMU offers k and Ti alone.
  Modelica.Blocks.Continuous.LimPID pid(
    controllerType = Modelica.Blocks.Types.SimpleController.PI,
    k = k, Ti = Ti, yMax = yMax, yMin = yMin, Ni = 0.9,
    initType = Modelica.Blocks.Types.Init.InitialState, xi_start = 0) "Limited PI controller with anti-windup";
equation
  connect(setpoint, pid.u_s);
  connect(measurement, pid.u_m);
  connect(pid.y, command);
  annotation(experiment(StartTime = 0, StopTime = 14400, Interval = 10));
end PidController;
