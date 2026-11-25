# Copyright © 2026 Zenin Easa Panthakkalakath

"""A recorded signal replayed: a relationship program that is a function of time alone (docs/programs.md).

It reads the recording when the run starts, in initialize(), from a CSV file (a time column, then the value; a heading row is
skipped), interpolates linearly between readings and holds the first and the last past either end. With no file named it replays the
readings written below, so it runs as it is.
"""

import csv

from konjugate.v2 import Output, Relationship


class CsvReplay(Relationship):
    """A recorded signal, read from a CSV file when the run starts and interpolated in time."""

    output = Output()

    # The CSV to read, by its path; empty replays the readings below.
    file = ""

    def initialize(self, setup, m):
        times, values = [0.0, 10.0, 20.0, 30.0], [290.0, 292.5, 291.0, 293.0]
        if self.file:
            times, values = [], []
            with open(self.file, newline="") as recording:
                for row in csv.reader(recording):
                    try:
                        time, value = float(row[0]), float(row[1])
                    except (IndexError, ValueError):
                        continue  # a heading, or a row that is not two numbers
                    times.append(time)
                    values.append(value)
            if len(times) < 2:
                raise ValueError(f"The recording {self.file} has fewer than two readings.")
        self.times, self.values = times, values

    def evaluate(self, t, x):
        times, values = self.times, self.values
        if t <= times[0]:
            return values[0]
        if t >= times[-1]:
            return values[-1]
        index = 0
        while index + 2 < len(times) and t > times[index + 1]:
            index += 1
        fraction = (t - times[index]) / (times[index + 1] - times[index])
        return values[index] + fraction * (values[index + 1] - values[index])
