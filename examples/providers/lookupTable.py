# Copyright © 2026 Zenin Easa Panthakkalakath

"""A valve's flow by its opening, from a table of measured points: a pure relationship program (docs/programs.md).

Between two points the flow is interpolated linearly; an opening outside the table is refused with OutOfDomain, so Adaptive and Stiff
try a smaller step and Euler and Runge–Kutta 4 stop with the message, rather than the program inventing a value it was never given.
"""

from konjugate.v2 import Input, OutOfDomain, Output, Relationship

# The measured points: the opening (0 closed, 1 open) and the flow through the valve at it.
OPENINGS = (0.0, 0.25, 0.5, 0.75, 1.0)
FLOWS = (0.0, 0.02, 0.07, 0.14, 0.2)


class LookupTable(Relationship):
    """A valve's flow by its opening, interpolated in a table of measured points."""

    opening = Input()
    flow = Output("m3/s")

    def evaluate(self, t, x):
        value = x.opening
        if not OPENINGS[0] <= value <= OPENINGS[-1]:
            raise OutOfDomain(f"The opening {value} is outside the table, which runs from 0 to 1.")
        index = 0
        while index + 2 < len(OPENINGS) and value > OPENINGS[index + 1]:
            index += 1
        fraction = (value - OPENINGS[index]) / (OPENINGS[index + 1] - OPENINGS[index])
        return FLOWS[index] + fraction * (FLOWS[index + 1] - FLOWS[index])
