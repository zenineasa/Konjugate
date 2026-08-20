"""Checkpointable computational-node provider contract example.

This demonstrates the NodeProvider wire contract in isolation -- describe(), evaluate(),
checkpoint() and restore() -- and is exercised directly by engine/tests/nodeProviderWorkerTest.py
and scripts/checkNodeProviderExample.mjs. Its evaluate() returns an already-integrated running
total as the "gradient", which is correct for demonstrating the protocol but would double-
integrate if wired into a real model through the engine's explicit-Euler state update. For a
provider the engine can actually run inside a model, see piControllerNode.py and
piControlledTankProject.json alongside this file, which return real per-substep derivatives.
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
