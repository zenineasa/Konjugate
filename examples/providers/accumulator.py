# Copyright © 2026 Zenin Easa Panthakkalakath

"""A running total kept in memory: the smallest node program with memory (docs/programs.md).

At every accepted step, advance() adds the input times the step to the total; evaluate() gives the total as the value of an Update state.
The total is memory, so the engine saves it with checkpoints and restores it, and a paused, resumed or forked run carries on exactly; no
checkpoint() or restore() is written by hand.

The version 2 rewrite of accumulatorNode.py, which shows the same running total in the older format's checkpoint contract: driven
alike, its total is that one's, to the bit (tests/engine/programRewrites.mjs).
"""

from konjugate.v2 import Input, Memory, Node, Output


class Accumulator(Node):
    """The running total of its input over time."""

    input = Input()
    output = Output()                        # the value of an Update state: the total so far

    total = Memory(0.0)

    def evaluate(self, t, x):
        return self.outputs(output=x.total)

    def advance(self, step, x, m):
        m.total = x.total + x.input * step.size
