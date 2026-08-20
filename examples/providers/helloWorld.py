"""Minimal Konjugate Python relationship provider example."""

from konjugate import (
    RelationshipDescription,
    RelationshipProvider,
    ScalarPort,
)


class HelloWorldProvider(RelationshipProvider):
    """Return twice the bound input as an additive derivative contribution."""

    def describe(self):
        return RelationshipDescription(
            "example.helloWorld",
            "Hello World",
            [ScalarPort("input", "Input", "")],
            ScalarPort("output", "Output", ""),
        )

    def evaluate(self, context, inputs, outputs):
        del context
        outputs.add_gradient(2.0 * inputs["input"])
