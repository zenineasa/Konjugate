# Copyright © 2026 Zenin Easa Panthakkalakath

"""Heat conducted from a hot body to a cold one: a pure relationship program (docs/programs.md)."""

from konjugate.v2 import Input, Output, Parameter, Relationship


class Conduction(Relationship):
    """Warms the cold side at G (Th - Tc) / C."""

    hot = Input("K")
    cold = Input("K")
    conductance = Parameter("W/K")
    capacity = Parameter("J/K")
    warming = Output("K/s")

    def evaluate(self, t, x):
        return x.conductance * (x.hot - x.cold) / x.capacity
