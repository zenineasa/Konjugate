# Copyright © 2026 Zenin Easa Panthakkalakath

"""A digital PID controller sampled every 10 ms, reading a noisy temperature sensor, with anti-windup: a node program with memory and a
clock (docs/programs.md). Its memory is exact, not an approximation: a digital controller is discrete by nature."""

from konjugate.v2 import Clock, Constant, Input, Memory, Node, Output, Parameter, Random


class PidController(Node):
    """A PID controller sampled every 10 ms, reading a noisy temperature sensor, with anti-windup."""

    measurement = Input("K")
    setpoint = Parameter("K")
    kp = Constant("W/K")
    ki = Constant("W/(K*s)")
    kd = Constant("W*s/K")
    max_power = Constant("W")
    sensor_noise = Constant("K", default=0.0)
    power = Output("W")                      # bound to the node's Update state "power"

    clock = Clock(0.01)                      # advance() at 0, 10 ms, 20 ms, ...

    integral = Memory(0.0, unit="K*s")
    previous_error = Memory(0.0, unit="K")
    held = Memory(0.0, unit="W")
    noise = Random()

    def evaluate(self, t, x):
        # The command is held between samples, as a real controller's output is.
        return self.outputs(power=x.held)

    def advance(self, step, x, m):
        measured = x.measurement + x.sensor_noise * m.noise.normal()
        error = x.setpoint - measured
        derivative = 0.0 if step.first else (error - x.previous_error) / step.size
        candidate = x.integral + error * step.size
        unclamped = x.kp * error + x.ki * candidate + x.kd * derivative
        command = min(max(unclamped, 0.0), x.max_power)
        if command == unclamped:             # stop integrating while saturated
            m.integral = candidate
        m.previous_error = error
        m.held = command
