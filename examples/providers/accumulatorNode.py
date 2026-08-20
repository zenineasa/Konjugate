"""Checkpointable computational-node provider contract example.

The current engine worker does not execute NodeProvider instances yet. This
example documents the intended lifecycle for the next runtime slice.
"""

import struct

from konjugate import NodeOutputCollector, NodeProvider, NodeProviderDescription, ScalarPort


class AccumulatorNode(NodeProvider):
    def __init__(self):
        self.total = 0.0

    def describe(self):
        return NodeProviderDescription(
            "example.accumulatorNode",
            "Accumulator node",
            [ScalarPort("input", "Input", "")],
            [ScalarPort("output", "Output", "")],
        )

    def evaluate(self, context, inputs, outputs):
        self.total += inputs["input"] * context.step_size
        outputs.add_gradient("output", self.total)

    def checkpoint(self):
        return struct.pack("!d", self.total)

    def restore(self, payload):
        if len(payload) != 8:
            raise ValueError("Accumulator checkpoint must contain one float.")
        self.total = struct.unpack("!d", payload)[0]
