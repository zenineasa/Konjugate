# Copyright © 2026 Zenin Easa Panthakkalakath

from konjugate import (
    EvaluationContext,
    InputView,
    OutputCollector,
    RelationshipDescription,
    RelationshipProvider,
    ScalarPort,
)


class ConductanceProvider(RelationshipProvider):
    def describe(self):
        return RelationshipDescription(
            "test.conductance",
            "Conductance",
            [ScalarPort("delta", "Temperature difference", "K")],
            ScalarPort("gradient", "Temperature gradient", "K/s"),
        )

    def evaluate(self, context, inputs, outputs):
        assert context.simulation_time == 1.5
        outputs.add_gradient(inputs["delta"] * 2)


provider = ConductanceProvider()
output = OutputCollector()
provider.evaluate(EvaluationContext(1.5, 0.01), InputView({"delta": 4}), output)
assert output.gradient == 8
assert provider.describe().inputs[0].key == "delta"
