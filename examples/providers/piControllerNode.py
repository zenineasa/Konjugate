# Copyright © 2026 Zenin Easa Panthakkalakath

"""A computational-node provider the engine can actually execute end to end.

Unlike accumulatorNode.py (which demonstrates the checkpointable NodeProvider wire contract in
isolation, and returns an already-integrated running total as its "gradient"), this provider
returns real derivatives suitable for the engine's own explicit-Euler integration: two engine-
visible states (level, cumulativeControlEffortSquared) via two named outputs, plus one internal,
checkpointable field -- the PI controller's integral term -- that has no analog anywhere in the
engine's own state vector. That integral term is why checkpoint()/restore() matter: without them,
pausing and resuming a run (or forking a branch from a checkpoint) would silently reset the
controller's memory to zero, producing a different trajectory than an uninterrupted run.

See examples/providers/piControlledTankProject.json for a minimal model that wires this in via a
node's `implementation` block.
"""

import struct

from konjugate import NodeOutputCollector, NodeProvider, NodeProviderDescription, ScalarPort


class PIControllerNode(NodeProvider):
    def __init__(self):
        self._integral = 0.0

    def describe(self):
        return NodeProviderDescription(
            "example.piControllerNode",
            "PI-controlled tank",
            [ScalarPort("level", "Tank level", "m")],
            [
                ScalarPort("levelRate", "Level rate of change", "m/s"),
                ScalarPort("effortRateSquared", "Squared control effort rate", ""),
            ],
        )

    def evaluate(self, context, inputs, outputs):
        setpoint = 10.0
        error = setpoint - inputs["level"]
        self._integral += error * context.step_size
        effort = 0.6 * error + 0.05 * self._integral
        outputs.add_gradient("levelRate", effort)
        outputs.add_gradient("effortRateSquared", effort * effort)

    def checkpoint(self):
        return struct.pack("!d", self._integral)

    def restore(self, payload):
        if len(payload) != 8:
            raise ValueError("PI controller checkpoint must contain one float.")
        self._integral = struct.unpack("!d", payload)[0]
