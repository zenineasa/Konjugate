# Copyright © 2026 Zenin Easa Panthakkalakath

from konjugate import (
    RelationshipDescription,
    RelationshipProvider,
    ScalarPort,
)


class DoubledConductanceProvider(RelationshipProvider):
    """A second, distinctly-behaved provider fixture. Used alongside
    pythonRelationshipProviderTest.py to prove that ProviderRuntime resolves a
    task's worker process and instance by its stable source ID rather than by
    a per-node local sequence number, which can collide across nodes."""

    def describe(self):
        return RelationshipDescription(
            "test.doubledConductance",
            "Doubled conductance",
            [ScalarPort("delta", "Temperature difference", "K")],
            ScalarPort("gradient", "Temperature gradient", "K/s"),
        )

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient(inputs["delta"] * 5)
