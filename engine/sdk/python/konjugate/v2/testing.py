# Copyright © 2026 Zenin Easa Panthakkalakath

"""A harness for trying a version 2 program outside Konjugate (docs/programs.md, "Testing a program")::

    from konjugate.v2.testing import Harness

    h = Harness(PidController, constants={"kp": 50.0, "ki": 5.0, "kd": 1.0, "max_power": 2000.0}, seed=7)
    h.tick(time=0.0, setpoint=293.15, measurement=290.0)           # advance() at a clock tick
    print(h.evaluate(t=0.0, setpoint=293.15, measurement=290.0))   # {'power': ...}
    print(h.memory)                                                # {'integral': ..., 'previousError': ..., ...}
    h.check(setpoint=293.15, measurement=290.0)                    # the standard checks, raising with a plain message

Inputs and constants are named as in the code (``max_power``) or as the file binds them (``maxPower``); one not given reads its
default, or 0. The checks are those Konjugate's Check program runs.
"""

import math
import re
import struct

from konjugate.v2 import describe
from konjugate.v2._host import DONE, NOT_PROVIDED, OUT_OF_DOMAIN, ProgramHost

__all__ = ["CheckFailed", "Harness"]

_IDENTIFIER = re.compile(r"^[a-z][A-Za-z0-9]*$")


class CheckFailed(AssertionError):
    """What check() raises: every problem found, one sentence each."""

    def __init__(self, problems):
        super().__init__("\n".join(problems))
        self.problems = list(problems)


def _bits(value):
    return struct.pack("<d", value)


class Harness:
    def __init__(self, program_class, constants=None, seed=0, owner=1, start_time=0.0):
        self.program_class = program_class
        self.description = describe(program_class)
        self._constants = dict(constants or {})
        self._seed = seed
        self._owner = owner
        self._start_time = start_time
        self._advanced = False
        self._host, self._id = self._start()

    def _start(self):
        host = ProgramHost(self.program_class)
        values = self._values({})
        bound = [1] * len(values)
        outcome = host.initialize([(1, "the harness", self._start_time, values, bound, self._owner, self._seed)])[0]
        if outcome["status"] != DONE:
            raise RuntimeError(f"initialize() failed: {outcome['message']}" + (f" (line {outcome['line']})" if outcome["line"] else ""))
        self._clock = outcome.get("clockPeriod", 0.0)
        return host, 1

    def _values(self, given):
        values = []
        known = set()
        for port in self.description.inputs:
            known.update((port.attribute, port.key))
            value = port.default if port.default is not None else 0.0
            for name in (port.attribute, port.key):
                if name in self._constants:
                    value = float(self._constants[name])
                if name in given:
                    value = float(given[name])
            values.append(value)
        for name in list(given) + list(self._constants):
            if name not in known:
                raise KeyError(
                    f"The program {self.description.name} has no input '{name}' "
                    f"({', '.join(port.attribute for port in self.description.inputs) or 'none declared'})."
                )
        return values

    @property
    def program(self):
        return self._host.instances[self._id].program

    @property
    def memory(self):
        """The program's memory now, by name; a random stream as [seed, counter]."""
        store = self._host.instances[self._id].store
        return {name: (list(value) if isinstance(value, list) else value) for name, value in store.items()}

    def evaluate(self, t=0.0, **inputs):
        """Every output's value at time t, by name."""
        outcome = self._host.evaluate(t, [(self._id, self._values(inputs))])[0]
        self._raise(outcome, "evaluate()")
        return {port.key: value for port, value in zip(self.description.outputs, outcome["outputs"])}

    def advance(self, time, size, **inputs):
        """advance() as at the end of an accepted step of `size` ending at `time`."""
        outcome = self._host.advance(time, size, [(self._id, self._values(inputs), not self._advanced)])[0]
        self._advanced = True
        self._raise(outcome, "advance()")

    def tick(self, time, **inputs):
        """advance() at a clock tick: the step is the clock's period."""
        self.advance(time, self._clock, **inputs)

    def _raise(self, outcome, call):
        if outcome["status"] == DONE:
            return
        where = f" (line {outcome['line']})" if outcome["line"] else ""
        kind = "refused these inputs" if outcome["status"] == OUT_OF_DOMAIN else "failed"
        raise RuntimeError(f"{call} {kind}: {outcome['message']}{where}")

    def check(self, t=0.0, **inputs):
        """The standard checks at time t with these inputs; raises CheckFailed listing every problem, and returns nothing when all pass."""
        problems = check_program(self.program_class, inputs, t=t, constants=self._constants, seed=self._seed, owner=self._owner)
        if problems:
            raise CheckFailed(problems)


def check_program(program_class, inputs=None, t=0.0, constants=None, seed=0, owner=1):
    """The standard checks (docs/programs.md, "Testing a program"), as a list of problems, empty when every one passes: every port
    declared once with a key valid in a file; evaluate() finite at the inputs with every output set; purity (two calls give identical
    bits and leave memory as it was); the memory round trip (memory restored into a fresh instance gives identical outputs and identical
    further advance()s); and a Jacobian, if the program gives one, agreeing with differences."""
    inputs = dict(inputs or {})
    problems = []
    try:
        description = describe(program_class)
    except TypeError as error:
        return [str(error)]
    keys = set()
    for port in description.inputs + description.outputs:
        if not _IDENTIFIER.match(port.key):
            problems.append(f"The port '{port.key}' is not a valid key: it must start with a small letter and hold only letters and digits.")
        if port.key in keys:
            problems.append(f"The port '{port.key}' is declared twice.")
        keys.add(port.key)
    if not description.outputs:
        problems.append("The program declares no output.")
    if problems:
        return problems
    try:
        harness = Harness(program_class, constants=constants, seed=seed, owner=owner)
    except Exception as error:  # noqa: BLE001
        return [str(error)]
    try:
        values = harness._values(inputs)
    except KeyError as error:
        return [str(error.args[0])]
    host, instance_id = harness._host, harness._id
    before = description.pack(host.instances[instance_id].store)
    first = host.evaluate(t, [(instance_id, values)])[0]
    if first["status"] != DONE:
        where = f" (line {first['line']})" if first["line"] else ""
        return [f"evaluate() failed at t = {t:g}: {first['message']}{where}"]
    for port, value in zip(description.outputs, first["outputs"]):
        if not math.isfinite(value):
            problems.append(f"evaluate() gave {value} for '{port.key}' at t = {t:g}.")
    second = host.evaluate(t, [(instance_id, values)])[0]
    for port, one, two in zip(description.outputs, first["outputs"], second["outputs"]):
        if _bits(one) != _bits(two):
            problems.append(
                f"The program gave a different '{port.key}' when called twice with the same inputs at t = {t:g} ({one:g}, then {two:g}). "
                "evaluate() must not change anything: keep what it remembers in declared memory and change it in advance()."
            )
    if description.pack(host.instances[instance_id].store) != before:
        problems.append("evaluate() changed the program's memory.")

    if description.has_advance or description.memory:
        fresh = Harness(program_class, constants=constants, seed=seed, owner=owner)
        fresh._host.set_memory([(fresh._id, description.pack(host.instances[instance_id].store))])
        size = harness._clock or 0.01
        for round_index in range(3):
            time = t + size * (round_index + 1)
            left = host.advance(time, size, [(instance_id, values, False)])[0]
            right = fresh._host.advance(time, size, [(fresh._id, values, False)])[0]
            if left["status"] != DONE:
                where = f" (line {left['line']})" if left["line"] else ""
                problems.append(f"advance() failed: {left['message']}{where}")
                break
            if left["memory"] != right["memory"]:
                problems.append(
                    "Memory restored into a fresh instance did not advance as the original did: something the program remembers is "
                    "not declared as memory."
                )
                break
            one = host.evaluate(time, [(instance_id, values)])[0]
            two = fresh._host.evaluate(time, [(fresh._id, values)])[0]
            if [_bits(value) for value in one["outputs"]] != [_bits(value) for value in two["outputs"]]:
                problems.append("A fresh instance with the same memory gave different outputs: the program keeps something outside its declared memory.")
                break

    jacobian = host.jacobian(t, [(instance_id, values)])[0]
    if jacobian["status"] == DONE:
        width = len(values)
        for column, port in enumerate(description.inputs):
            step = 1e-6 * max(1.0, abs(values[column]))
            above, below = list(values), list(values)
            above[column] += step
            below[column] -= step
            high = host.evaluate(t, [(instance_id, above)])[0]["outputs"]
            low = host.evaluate(t, [(instance_id, below)])[0]["outputs"]
            for row, output in enumerate(description.outputs):
                differenced = (high[row] - low[row]) / (2.0 * step)
                given = jacobian["outputs"][row * width + column]
                if abs(differenced - given) > 1e-4 * max(1.0, abs(differenced)):
                    problems.append(
                        f"The Jacobian's entry for '{output.key}' by '{port.key}' is {given:g}, but differences give {differenced:g}."
                    )
    elif jacobian["status"] != NOT_PROVIDED:
        problems.append(f"jacobian() failed: {jacobian['message']}")
    return problems
