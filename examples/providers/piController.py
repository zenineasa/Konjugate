# Copyright © 2026 Zenin Easa Panthakkalakath

"""A PI-controlled tank: a node program with memory (docs/programs.md).

The controller fills the tank toward a level of 10 m. It is sampled every samplePeriod (50 ms unless bound): at each sample, advance()
reads the level, adds the error times the period to the integral and works out the control effort, which is held until the next sample.
The integral and the effort are memory, which the engine saves and restores with checkpoints, so pausing, resuming or forking a run
carries on exactly. evaluate() gives the effort as the level's rate of change, and its square as the rate of the cumulative squared
effort.

The version 2 rewrite of piControllerNode.py, which integrates in evaluate() at every step: run at a global step equal to the sample
period under Euler, the two give the same numbers to the bit (tests/engine/programRewrites.mjs). See piControlledTank.json for a model
that uses it.
"""

from konjugate.v2 import Clock, Constant, Input, Memory, Node, Output


class PIController(Node):
    """A PI controller filling a tank toward a level of 10 m."""

    level = Input("m")
    sample_period = Constant("s", default=0.05)
    level_rate = Output("m/s")               # into the Rate state "level"
    effort_rate_squared = Output()           # into the Rate state "cumulativeControlEffortSquared"

    clock = Clock(sample_period)             # advance() at the start and every sample period: a whole number of the run's steps

    integral = Memory(0.0, unit="m*s")
    effort = Memory(0.0, unit="m/s")

    def evaluate(self, t, x):
        return self.outputs(level_rate=x.effort, effort_rate_squared=x.effort * x.effort)

    def advance(self, step, x, m):
        setpoint = 10.0
        error = setpoint - x.level
        integral = x.integral + error * step.size
        m.integral = integral
        m.effort = 0.6 * error + 0.05 * integral
