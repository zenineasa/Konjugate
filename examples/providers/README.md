# Provider examples

Programs in the current format, written against the program SDK (`konjugate/sdk/v2/program.hpp` in C++, `konjugate.v2` in Python), are what Konjugate's templates write and where a new program should start; [Writing a program](../../docs/programs.md) explains them:

- [conduction.py](conduction.py) and [conduction.cpp](conduction.cpp): a relationship, the heat conducted from a hot body to a cold one, giving to the bit the numbers of the equation it replaces.
- [pidController.py](pidController.py) and [pidController.cpp](pidController.cpp): a node, a digital PID controller sampled every 10 ms, with memory and a clock.
- [accumulator.py](accumulator.py): a node, the running total of its input, kept in memory: the smallest node program with memory.
- [piController.py](piController.py) and the project [piControlledTank.json](piControlledTank.json) that uses it: a node, a PI controller filling a tank, sampled on a clock, its integral and its effort kept in memory.

The rest of this folder is written in the older program format (`from konjugate import ...`, `konjugate/relationshipProvider.hpp`), which keeps working as it did: [helloWorld.py](helloWorld.py), [accumulatorNode.py](accumulatorNode.py), [piControllerNode.py](piControllerNode.py) and the project [piControlledTankProject.json](piControlledTankProject.json). They are described below. accumulator.py, piController.py and piControlledTank.json are their rewrites in the current format, and give their numbers to the bit (the tank at a global step equal to the controller's sample period, 50 ms, under Euler): `tests/engine/programRewrites.mjs` shows it, as it does for the component library's two PID assemblies, which now carry version 2 programs. A project that already holds one of these keeps the program it has.

## Hello World (older format)

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

A provider receives only the values declared in its bindings and returns its result (in the older format, an additive contribution through `OutputCollector`). It does not receive mutable
engine memory, a project object or an ambient filesystem/network capability.
Keep provider source deterministic unless the model explicitly documents an
external dependency.

## Checkpointable node-provider contract (older format)

The [accumulator node](accumulatorNode.py) demonstrates the next provider
capability: multiple named outputs and deterministic checkpoint/restore state.
Run its cross-platform conformance check from the repository root:

```bash
npm run test:node-provider
```

This verifies one evaluation, serializes the provider state, changes the live state, restores the checkpoint and confirms the original value is recovered, without the engine. The engine itself runs node programs from a project, as it runs the Tank of [piControlledTankProject.json](piControlledTankProject.json); in the current format a node program declares its memory instead, and the engine saves and restores it (see [Writing a program](../../docs/programs.md)).
