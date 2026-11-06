# Copyright © 2026 Zenin Easa Panthakkalakath
"""A tuning objective written as a Python program.

Write a module with a function ``objective(run)`` returning the number a run scores::

    def objective(run):
        temperature = run.series("temperature")   # a bound state's value at every output time
        peak = max(temperature)
        run.report("peak", peak)                  # further numbers, by name, if any
        return settling_time(run.times, temperature)

The engine starts it once for a whole tuning, as ``python -m konjugate.objective <program.py>``, and hands it every trial's run in
turn over stdin and stdout (an ObjectiveRunRequest in, an ObjectiveRunResult out, framed as every message of the engine is: see
protocol/engineProtocol.proto). A key is bound in the tuning card to a state (its series), a measured column (its series) or a tuned
parameter (its value in the trial). An exception raised by ``objective`` fails that trial, with its message shown; the tuning goes on.
Only the standard library is used.
"""

import importlib.util
import struct
import sys
import traceback
from pathlib import Path

from konjugate.__main__ import _decode_fields, _encode_bool_field, _encode_double_field, _encode_length_delimited


class Run:
    """One trial's run, as the objective sees it."""

    def __init__(self, times, series, values):
        self.times = times
        self._series = series
        self._values = values
        self._reports = []

    def series(self, key):
        """A bound state's or measured column's series, one value per output time."""
        if key not in self._series:
            raise KeyError(f'No series is bound to the key "{key}".')
        return self._series[key]

    def value(self, key):
        """A bound parameter's value in this trial."""
        if key not in self._values:
            raise KeyError(f'No value is bound to the key "{key}".')
        return self._values[key]

    def has(self, key):
        return key in self._series or key in self._values

    def report(self, key, value):
        """A further number, by name, reported beside the objective."""
        self._reports.append((str(key), float(value)))


def _doubles(wire, value):
    if wire == 1:
        return [value]
    return list(struct.unpack(f"<{len(value) // 8}d", value))


def decode_run(data):
    times, series, values = [], {}, {}
    for field, wire, value in _decode_fields(data):
        if field == 1:
            times.extend(_doubles(wire, value))
        elif field in (2, 3) and wire == 2:
            key, numbers = "", []
            for part, part_wire, part_value in _decode_fields(value):
                if part == 1 and part_wire == 2:
                    key = bytes(part_value).decode("utf-8")
                elif part == 2:
                    numbers.extend(_doubles(part_wire, part_value))
            if field == 2:
                series[key] = numbers
            else:
                values[key] = numbers[0] if numbers else 0.0
    return Run(times, series, values)


def encode_result(value=None, message=None, reports=()):
    if message is not None:
        return _encode_length_delimited(2, message)
    out = _encode_bool_field(1, True) + _encode_double_field(3, float(value))
    for key, reported in reports:
        out += _encode_length_delimited(4, _encode_length_delimited(1, key) + _encode_double_field(2, reported))
    return out


def _read_exact(stream, size):
    data = b""
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def main():
    if len(sys.argv) != 2:
        print("usage: python -m konjugate.objective <program.py>", file=sys.stderr)
        return 64
    path = Path(sys.argv[1])
    spec = importlib.util.spec_from_file_location("konjugate_objective_program", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    function = getattr(module, "objective", None)
    if not callable(function):
        print(f"{path.name} has no objective(run) function.", file=sys.stderr)
        return 65
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        header = _read_exact(stdin, 4)
        if header is None:
            return 0
        (size,) = struct.unpack(">I", header)
        data = _read_exact(stdin, size) if size else b""
        if data is None:
            return 0
        try:
            run = decode_run(data)
            result = encode_result(function(run), reports=run._reports)
        except Exception as error:  # the person's code: any failure fails the trial, with its message
            traceback.print_exc(file=sys.stderr)
            result = encode_result(message=f"{type(error).__name__}: {error}")
        stdout.write(struct.pack(">I", len(result)) + result)
        stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
