# Copyright © 2026 Zenin Easa Panthakkalakath

"""Tests of version 2 of the Python program SDK (konjugate.v2) outside the engine: the harness, the standard checks (each failing for a
deliberately broken program with its message), memory, clocks, the seeded random stream, one object per instance and the read check."""

import math
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples" / "providers"))

from konjugate.v2 import Clock, Constant, Input, Memory, Node, Output, Parameter, Random, Relationship, random_seed  # noqa: E402
from konjugate.v2._host import ProgramHost, ProgramLoadError, check_reads, load_program_class  # noqa: E402
from konjugate.v2.testing import CheckFailed, Harness, check_program  # noqa: E402

from conduction import Conduction  # noqa: E402
from pidController import PidController  # noqa: E402


def expect_problem(program, pattern, **inputs):
    problems = check_program(program, inputs)
    assert any(pattern in problem for problem in problems), f"expected {pattern!r} in {problems}"


# The worked examples pass every check.
conduction = Harness(Conduction)
assert conduction.evaluate(hot=310, cold=295, conductance=4, capacity=2) == {"warming": 30.0}
conduction.check(hot=310, cold=295, conductance=4, capacity=2)
pid = Harness(PidController, constants={"kp": 50.0, "ki": 5.0, "kd": 1.0, "max_power": 2000.0}, seed=7)
pid.tick(time=0.0, setpoint=293.15, measurement=290.0)
assert pid.memory["held"] > 0 and pid.memory["previousError"] == 293.15 - 290.0, pid.memory
assert pid.evaluate(t=0.0, setpoint=293.15, measurement=290.0)["power"] == pid.memory["held"]
pid.check(setpoint=293.15, measurement=290.0)
# Keys as the file binds them work as well as the code's names.
assert Harness(PidController, constants={"maxPower": 10.0, "kp": 50.0, "ki": 0.0, "kd": 0.0}).evaluate(measurement=0, setpoint=0) == {"power": 0.0}

# The description: keys in camelCase, kinds, units, defaults, memory in 8-byte slots, the clock.
described = ProgramHost(PidController).describe()
assert [port["key"] for port in described["inputs"]] == ["measurement", "setpoint", "kp", "ki", "kd", "maxPower", "sensorNoise"]
assert [port["kind"] for port in described["inputs"]][:3] == ["input", "parameter", "constant"]
assert described["inputs"][-1]["default"] == 0.0 and described["clockPeriod"] == 0.01
assert [(field["name"], field["offset"]) for field in described["memory"]] == [("integral", 0), ("previousError", 8), ("held", 16), ("noise", 24)]
assert described["memorySize"] == 40


# Purity: a member changed in evaluate() is refused by the frozen object, with where memory belongs.
class Counting(Relationship):
    a = Input()
    y = Output()

    def evaluate(self, t, x):
        self.calls = 1
        return x.a


expect_problem(Counting, "cannot set 'calls' after initialize()", a=1)


# A missing output is Python's own TypeError, naming it.
class Missing(Node):
    a = Input()
    y = Output()
    z = Output()

    def evaluate(self, t, x):
        return self.outputs(y=x.a)


expect_problem(Missing, "missing 1 required keyword-only argument: 'z'", a=1)


# A wrong Jacobian is found against differences; a right one passes.
class Square(Relationship):
    a = Input()
    y = Output()

    def evaluate(self, t, x):
        return x.a * x.a

    def jacobian(self, t, x):
        return {("y", "a"): 2.0 * x.a}


assert check_program(Square, {"a": 3.0}) == []


class WrongSquare(Square):
    def jacobian(self, t, x):
        return {("y", "a"): x.a}


expect_problem(WrongSquare, "The Jacobian's entry for 'y' by 'a' is 3, but differences give 6", a=3.0)


# Memory changes only in advance(); a stream is drawn only there, and the same seed gives the same draws.
class Noisy(Node):
    a = Input()
    y = Output()
    noise = Random()
    last = Memory(0.0)

    def evaluate(self, t, x):
        return self.outputs(y=x.last)

    def advance(self, step, x, m):
        m.last = m.noise.normal()


class DrawsInEvaluate(Noisy):
    def evaluate(self, t, x):
        return self.outputs(y=x.noise.normal())


expect_problem(DrawsInEvaluate, "can be drawn only in advance()", a=0)
first, second = Harness(Noisy, seed=3), Harness(Noisy, seed=3)
for step in range(5):
    first.advance(0.1 * (step + 1), 0.1, a=0)
    second.advance(0.1 * (step + 1), 0.1, a=0)
assert first.memory == second.memory and first.memory["noise"][1] == 10
assert random_seed(1, 0, "noise") != random_seed(2, 0, "noise"), "Two instances draw different streams."
assert random_seed(1, 0, "noise") != random_seed(1, 5, "noise"), "A seed set on the card draws another stream."
draws = Harness(Noisy, seed=3)
for step in range(2000):
    draws.advance(step * 0.01, 0.01, a=0)
assert math.isfinite(draws.memory["last"])


# One object per instance: two instances keep their own memory.
class Counter(Node):
    a = Input()
    y = Output()
    count = Memory(0)

    def evaluate(self, t, x):
        return self.outputs(y=float(x.count))

    def advance(self, step, x, m):
        m.count = x.count + 1


host = ProgramHost(Counter)
host.initialize([(1, "node A", 0.0, [0.0], [1], 11, 0), (2, "node B", 0.0, [0.0], [1], 12, 0)])
host.advance(0.1, 0.1, [(1, [0.0], True)])
assert [outcome["outputs"] for outcome in host.evaluate(0.1, [(1, [0.0]), (2, [0.0])])] == [[1.0], [0.0]]


# A clock's period may be a constant, read at initialize().
class Sampled(Node):
    period = Constant("s")
    y = Output()
    clock = Clock(period)
    ticks = Memory(0)

    def evaluate(self, t, x):
        return self.outputs(y=float(x.ticks))

    def advance(self, step, x, m):
        m.ticks = x.ticks + 1


started = ProgramHost(Sampled).initialize([(1, "node S", 0.0, [0.05], [1], 1, 0)])[0]
assert started["clockPeriod"] == 0.05 and ProgramHost(Sampled).describe()["clockConstant"] == "period"

# A misspelt port is found by reading the source, with its line.
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "typo.py"
    path.write_text((ROOT / "examples" / "providers" / "conduction.py").read_text().replace("x.capacity", "x.capactiy"))
    try:
        load_program_class(str(path), "_typo_program")
    except ProgramLoadError as error:
        assert "reads 'capactiy', which is not one of its inputs or memory" in str(error) and "Line 18." in str(error), error
    else:
        raise AssertionError("A misspelt port must be refused when the program is loaded.")

print("konjugate.v2 behaves as the program SDK says.")
