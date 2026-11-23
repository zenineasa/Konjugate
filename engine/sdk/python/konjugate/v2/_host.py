# Copyright © 2026 Zenin Easa Panthakkalakath

"""Serves one version 2 program class to the engine: one object per instance, memory kept here and returned after every advance(),
outcomes with a status (0 done, 1 failed, 2 out of domain, 3 not provided), a message and the author's line. Used by the pipe worker
(konjugate/__main__.py) and the web edition's bridge (konjugate/_webBridge.py) alike, on already-decoded values."""

import ast
import importlib.util
import math
import sys
import traceback

from konjugate.v2 import OutOfDomain, Program, Setup, Step, _freeze, describe

DONE, FAILED, OUT_OF_DOMAIN, NOT_PROVIDED = 0, 1, 2, 3


class ProgramLoadError(RuntimeError):
    pass


def find_program_class(module):
    """The one Relationship or Node subclass a module defines (not one it imports)."""
    from konjugate.v2 import Node, Relationship

    found = [
        value
        for value in vars(module).values()
        if isinstance(value, type)
        and issubclass(value, Program)
        and value not in (Program, Relationship, Node)
        and value.__module__ == module.__name__
    ]
    if not found:
        raise ProgramLoadError("The program defines no class derived from konjugate.v2's Relationship or Node.")
    if len(found) > 1:
        names = ", ".join(sorted(cls.__name__ for cls in found))
        raise ProgramLoadError(f"The program defines several programs ({names}); a source holds one.")
    return found[0]


def check_reads(source, cls, filename="<program>"):
    """Reads the source without running it, for a misspelt port: every x.<name> read in evaluate(), advance() and jacobian(), and every
    m.<name> in advance() and initialize(), must be a declared input or memory. Raises naming the line."""
    description = describe(cls)
    readable = set(description.input_attributes) | set(description.memory_attributes)
    writable = set(description.memory_attributes)
    try:
        tree = ast.parse(source, filename)
    except SyntaxError:
        return
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef) or node.name != cls.__name__:
            continue
        for method in node.body:
            if not isinstance(method, ast.FunctionDef):
                continue
            parameters = [argument.arg for argument in method.args.args]
            names = {}
            if method.name in ("evaluate", "jacobian") and len(parameters) >= 3:
                names[parameters[2]] = ("x", readable)
            elif method.name == "advance" and len(parameters) >= 4:
                names[parameters[2]] = ("x", readable)
                names[parameters[3]] = ("m", writable)
            elif method.name == "initialize" and len(parameters) >= 3:
                names[parameters[2]] = ("m", writable)
            for inner in ast.walk(method):
                if isinstance(inner, ast.Attribute) and isinstance(inner.value, ast.Name) and inner.value.id in names:
                    role, allowed = names[inner.value.id]
                    if inner.attr not in allowed:
                        what = "inputs or memory" if role == "x" else "memory"
                        listed = ", ".join(sorted(allowed)) or "none declared"
                        raise ProgramLoadError(
                            f"The program {cls.__name__} reads '{inner.attr}', which is not one of its {what} ({listed}). Line {inner.lineno}."
                        )


def load_program_class(module_path, module_name="_konjugate_user_program"):
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ProgramLoadError(f"Could not load the program at {module_path}.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    cls = find_program_class(module)
    try:
        with open(module_path, encoding="utf-8") as stream:
            check_reads(stream.read(), cls, module_path)
    except OSError:
        pass
    return cls


def author_line(error, filename):
    """The line of the author's own code an exception came from: the innermost frame in the program's file."""
    line = 0
    for frame in traceback.extract_tb(error.__traceback__):
        if filename and frame.filename == filename:
            line = frame.lineno or 0
    return line


def describe_error(error):
    text = str(error)
    if isinstance(error, TypeError) and "outputs()" in text:
        return text
    return f"{type(error).__name__}: {text}" if not isinstance(error, (OutOfDomain, RuntimeError, ValueError)) or not text else text


class _Instance:
    __slots__ = ("program", "store", "bound", "owner")

    def __init__(self, program, store, bound, owner):
        self.program = program
        self.store = store
        self.bound = bound
        self.owner = owner


class ProgramHost:
    """One program class, its instances and their memory."""

    def __init__(self, cls, filename=None):
        self.cls = cls
        self.filename = filename or getattr(sys.modules.get(cls.__module__), "__file__", None)
        self.description = describe(cls)
        self.instances = {}

    def describe(self):
        return self.description.describe()

    def _outcome(self, instance_id, status, error):
        return {
            "instanceId": instance_id,
            "outputs": [],
            "status": status,
            "message": describe_error(error),
            "line": author_line(error, self.filename),
            "memory": b"",
        }

    def initialize(self, instances):
        """instances: [(instance_id, owner, start_time, values, bound, owner_id, program_seed)]. Returns outcomes with each instance's
        starting memory and clock period."""
        description = self.description
        outcomes = []
        for instance_id, owner, start_time, values, bound, owner_id, program_seed in instances:
            try:
                program = self.cls()
                store = description.initial_memory(owner_id, program_seed)
                constants = {port.attribute: values[port.index] for port in description.inputs}
                program.initialize(Setup(instance_id, owner, start_time, constants), description.writer(store))
                _freeze(program)
                clock = description.clock
                period = 0.0
                if clock is not None:
                    period = values[clock.period.index] if hasattr(clock.period, "index") and clock.period.index is not None else float(clock.period)
                self.instances[instance_id] = _Instance(program, store, bound, owner)
                outcomes.append({"instanceId": instance_id, "outputs": [], "status": DONE, "message": "", "line": 0,
                                 "memory": description.pack(store), "clockPeriod": period})
            except Exception as error:  # noqa: BLE001 -- reported to the engine with the author's line
                outcome = self._outcome(instance_id, FAILED, error)
                outcome["clockPeriod"] = 0.0
                outcomes.append(outcome)
        return outcomes

    def evaluate(self, time, calls):
        """calls: [(instance_id, values)]. Returns outcomes with each instance's outputs in declaration order."""
        description = self.description
        node = description.node
        output_count = len(description.outputs)
        outcomes = []
        for instance_id, values in calls:
            instance = self.instances[instance_id]
            try:
                result = instance.program.evaluate(time, description.view(values, instance.store))
                if node:
                    if not isinstance(result, tuple) or len(result) != output_count:
                        raise TypeError(
                            f"evaluate() must return self.outputs(...) with every output ({', '.join(port.key for port in description.outputs)})."
                        )
                    outputs = [float(value) for value in result]
                else:
                    if result is None:
                        raise TypeError("evaluate() returned nothing: a relationship returns its one output's value.")
                    outputs = [float(result)]
                outcomes.append({"instanceId": instance_id, "outputs": outputs, "status": DONE, "message": "", "line": 0, "memory": b""})
            except OutOfDomain as error:
                outcomes.append(self._outcome(instance_id, OUT_OF_DOMAIN, error))
            except Exception as error:  # noqa: BLE001 -- reported to the engine with the author's line
                outcomes.append(self._outcome(instance_id, FAILED, error))
        return outcomes

    def advance(self, time, size, calls):
        """calls: [(instance_id, values, first)]. Returns outcomes with each instance's memory after advance()."""
        description = self.description
        outcomes = []
        for instance_id, values, first in calls:
            instance = self.instances[instance_id]
            try:
                instance.program.advance(Step(time, size, bool(first)), description.view(values, instance.store), description.writer(instance.store))
                outcomes.append({"instanceId": instance_id, "outputs": [], "status": DONE, "message": "", "line": 0,
                                 "memory": description.pack(instance.store)})
            except Exception as error:  # noqa: BLE001 -- reported to the engine with the author's line
                outcomes.append(self._outcome(instance_id, FAILED, error))
        return outcomes

    def set_memory(self, memories):
        """memories: [(instance_id, bytes)]: a restore."""
        for instance_id, data in memories:
            self.instances[instance_id].store = self.description.unpack(data)

    def jacobian(self, time, calls):
        """calls: [(instance_id, values)]. Returns outcomes with entries (outputs x inputs, row by output), or status 3."""
        description = self.description
        if not description.has_jacobian:
            return [{"instanceId": instance_id, "outputs": [], "status": NOT_PROVIDED, "message": "", "line": 0, "memory": b""}
                    for instance_id, _ in calls]
        inputs = {port.key: port.index for port in description.inputs}
        inputs.update({port.attribute: port.index for port in description.inputs})
        outputs = {port.key: port.index for port in description.outputs}
        outputs.update({port.attribute: port.index for port in description.outputs})
        width = len(description.inputs)
        outcomes = []
        for instance_id, values in calls:
            instance = self.instances[instance_id]
            try:
                given = instance.program.jacobian(time, description.view(values, instance.store)) or {}
                entries = [0.0] * (width * len(description.outputs))
                for (output, input_name), value in given.items():
                    if output not in outputs:
                        raise KeyError(f"jacobian() names the output '{output}', which is not declared.")
                    if input_name not in inputs:
                        raise KeyError(f"jacobian() names the input '{input_name}', which is not declared.")
                    entries[outputs[output] * width + inputs[input_name]] = float(value)
                outcomes.append({"instanceId": instance_id, "outputs": entries, "status": DONE, "message": "", "line": 0, "memory": b""})
            except Exception as error:  # noqa: BLE001
                outcomes.append(self._outcome(instance_id, FAILED, error))
        return outcomes

    def shutdown(self):
        for instance in self.instances.values():
            try:
                instance.program.shutdown()
            except Exception:  # noqa: BLE001 -- shutdown must not throw
                pass


def finite(values):
    return all(math.isfinite(value) for value in values)
