# Provider examples

These examples use the shipped Python relationship-provider SDK. They are
standalone source files that can be embedded in a project's `implementation`
object or adapted into a reusable provider package when that packaging layer
becomes available.

## Hello World

[helloWorld.py](helloWorld.py) declares one input port and one output port. For
each evaluation it returns twice the input as an additive derivative
contribution:

```text
output contribution = 2 * input
```

The example is intentionally simple. It demonstrates the provider lifecycle,
port declaration, read-only input access and output collection without hiding
the contract behind a helper framework.

## Check the provider locally

From the repository root, point Python at the shipped SDK and import the
provider:

```bash
PYTHONPATH=engine/sdk/python python - <<'PY'
from examples.providers.helloWorld import HelloWorldProvider
from konjugate import InputView, OutputCollector, EvaluationContext

provider = HelloWorldProvider()
assert provider.describe().provider_id == "example.helloWorld"
outputs = OutputCollector()
provider.evaluate(EvaluationContext(0.0, 0.1), InputView({"input": 3.0}), outputs)
assert outputs.gradient == 6.0
print("Hello World provider is valid")
PY
```

The application launches project-owned Python providers through the SDK worker:

```bash
PYTHONPATH=engine/sdk/python python -m konjugate examples/providers/helloWorld.py
```

The worker expects the engine protocol on standard input, so the command will
wait for framed engine messages when run by itself. It is a useful smoke check
for module loading; a complete protocol interaction should be exercised through
`npm run test:engine` or a model that references the provider.

## Provider boundary

A provider receives only the values declared in its bindings and returns an
additive contribution through `OutputCollector`. It does not receive mutable
engine memory, a project object or an ambient filesystem/network capability.
Keep provider source deterministic unless the model explicitly documents an
external dependency.
