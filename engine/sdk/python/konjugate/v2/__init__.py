# Copyright © 2026 Zenin Easa Panthakkalakath

"""Version 2 of Konjugate's program SDK (docs/programs.md, "Writing a program").

A program is a class derived from Relationship (one output: an interaction term on a relationship, or a node's own part) or Node
(several outputs for one node). It declares its ports, memory and an optional clock as class attributes, each written once::

    class Conduction(Relationship):
        hot = Input("K")                 # a value bound to a state (or the time)
        cold = Input("K")
        conductance = Parameter("W/K")   # a value bound to a parameter; may change while running
        capacity = Constant("J/K")       # fixed for the run; initialize() may read it
        warming = Output("K/s")          # what the program computes

        def evaluate(self, t, x):
            return x.conductance * (x.hot - x.cold) / x.capacity

A port's key in the project file is its attribute name in camelCase (``previous_error`` binds as ``previousError``); ``name=`` sets
another. ``x`` is a read-only view of the inputs, parameters, constants and memory; ``m``, given only to advance() and initialize(), is
where memory changes (``m.integral = ...``, ``m.noise.normal()``). A relationship's evaluate() returns its one output; a node's returns
``self.outputs(name=value, ...)``, whose keyword parameters are exactly its declared outputs.

What each call may do:

    construction   once per instance        nothing: the class attributes are the description
    initialize()   once per instance,       read constants (setup.kp), open and read files, set attributes on self and memory's
                   before the run and       starting values through m
                   before a restore
    evaluate()     any number of times      compute; change nothing, do no I/O
    advance()      once per accepted step   change memory; do no I/O (a fork from an earlier checkpoint repeats it)
                   or clock tick
    shutdown()     once                     release what initialize() took

evaluate() may be called at any stage of any method, for steps that will be rejected and for states perturbed for a Jacobian; it must
give the same outputs for the same (t, inputs, memory). After initialize() the object is frozen: an attribute set on self in evaluate() or
advance() raises. Memory changes only in advance(), which the engine calls once per accepted step, or once per tick of a declared clock,
and the engine saves and restores memory itself. A quantity that changes continuously (an analogue integrator, a filter) is a node's
state that an output drives, not memory: the method then integrates it to its own order.
"""

import math
import re
import struct

__all__ = [
    "Clock",
    "Constant",
    "Input",
    "Memory",
    "Node",
    "OutOfDomain",
    "Output",
    "Parameter",
    "Program",
    "Random",
    "Relationship",
    "Setup",
    "Step",
    "random_seed",
]

_MASK = (1 << 64) - 1
_GOLDEN = 0x9E3779B97F4A7C15


def _mix_bits(value):
    """splitmix64's finaliser, exactly as the engine's noise schedules and the C++ SDK use it."""
    value = (value + _GOLDEN) & _MASK
    value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & _MASK
    value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & _MASK
    return value ^ (value >> 31)


def _name_hash(name):
    hash_value = 0xCBF29CE484222325
    for byte in name.encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * 0x100000001B3) & _MASK
    return hash_value


def random_seed(owner, program_seed, field):
    """A Random stream's seed from the program instance's place in the model, the program's optional seed and the field's name."""
    return _mix_bits(_mix_bits((owner & _MASK) ^ _mix_bits(program_seed & _MASK)) ^ _name_hash(field))


def _camel(name):
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest if part)


_IDENTIFIER = re.compile(r"^[a-z][A-Za-z0-9]*$")


class OutOfDomain(Exception):
    """Raised by evaluate(): these inputs are outside what the program can compute. Under Adaptive and Stiff the step is rejected and
    tried smaller; under Euler and Runge-Kutta 4 the run stops with the message."""


class _Declaration:
    order = 0

    def __init__(self):
        _Declaration.order += 1
        self._order = _Declaration.order
        self.attribute = None

    def __set_name__(self, owner, name):
        self.attribute = name


class _Port(_Declaration):
    kind = "input"

    def __init__(self, unit="", *, name=None, default=None):
        super().__init__()
        self.unit = unit
        self._name = name
        self.default = None if default is None else float(default)
        self.index = None

    @property
    def key(self):
        return self._name or _camel(self.attribute)


class Input(_Port):
    """A value bound to a state (or the time). With ``default=``, it may be left unbound."""

    kind = "input"


class Parameter(_Port):
    """A value bound to a parameter, read at every call; it may change between steps or follow a schedule within one."""

    kind = "parameter"


class Constant(_Port):
    """A parameter fixed for the run: never live or scheduled, readable in initialize() as ``setup.<name>``."""

    kind = "constant"


class Output(_Declaration):
    """What the program computes. ``depends_on=("hot", "cold")`` names the inputs it reads, when not every one: it sharpens the sparsity a
    stiff method's Jacobian is worked out on."""

    def __init__(self, unit="", *, name=None, depends_on=None):
        super().__init__()
        self.unit = unit
        self._name = name
        self.depends_on = None if depends_on is None else tuple(depends_on)
        self.index = None

    @property
    def key(self):
        return self._name or _camel(self.attribute)


class Clock(_Declaration):
    """advance() at the start, then every ``period`` seconds, rather than at every accepted step. ``period`` is a number of seconds or a
    Constant; it must be a whole number of the run's global steps."""

    def __init__(self, period):
        super().__init__()
        self.period = period


class Memory(_Declaration):
    """Something the program remembers between steps: a float, an int, a bool, or a list of floats (of fixed length). Read through x,
    changed only through m in advance() and initialize(); the engine keeps, saves and restores it."""

    type = None

    def __init__(self, initial=0.0, *, unit=""):
        super().__init__()
        self.unit = unit
        if isinstance(initial, bool):
            self.type, self.count, self.initial = "flag", 1, bool(initial)
        elif isinstance(initial, int):
            self.type, self.count, self.initial = "integer", 1, int(initial)
        elif isinstance(initial, (list, tuple)):
            self.type, self.count, self.initial = "reals", len(initial), [float(value) for value in initial]
        else:
            self.type, self.count, self.initial = "real", 1, float(initial)
        self.offset = None

    @property
    def name(self):
        return _camel(self.attribute)

    @property
    def slots(self):
        return 2 if self.type == "random" else self.count


class Random(Memory):
    """A random stream kept in memory, seeded by the engine: ``m.noise.uniform()``, ``m.noise.normal()``, ``m.noise.bits()``. Drawing
    changes it, so it can be drawn only in advance()."""

    def __init__(self):
        _Declaration.__init__(self)
        self.unit = ""
        self.type, self.count, self.initial = "random", 1, None
        self.offset = None


class _Stream:
    __slots__ = ("_store", "_name", "_writable")

    def __init__(self, store, name, writable):
        self._store = store
        self._name = name
        self._writable = writable

    def bits(self):
        if not self._writable:
            raise RuntimeError(
                f"The random stream '{self._name}' can be drawn only in advance(), through m: drawing changes it, and evaluate() "
                "changes nothing."
            )
        seed, counter = self._store[self._name]
        counter = (counter + 1) & _MASK
        self._store[self._name] = [seed, counter]
        return _mix_bits((seed + counter * _GOLDEN) & _MASK)

    def uniform(self):
        """In [0, 1)."""
        return (self.bits() >> 11) * (1.0 / 9007199254740992.0)

    def normal(self):
        """Mean 0, standard deviation 1: Box-Muller on two draws, nothing cached."""
        first = self.uniform()
        second = self.uniform()
        return math.sqrt(-2.0 * math.log(1.0 - first)) * math.cos(6.283185307179586 * second)

    @property
    def seed(self):
        return self._store[self._name][0]

    @property
    def counter(self):
        return self._store[self._name][1]


class Step:
    """What advance() is told: the end of the accepted step (or the clock's tick), its size (or the clock's period), and whether it is
    the first advance() of a run (not of a run continued from a checkpoint)."""

    __slots__ = ("time", "size", "first")

    def __init__(self, time, size, first):
        self.time = time
        self.size = size
        self.first = first


class Setup:
    """What initialize() is told: the instance's id, what it belongs to ("node Heater"), the start time, and its constants as
    attributes (``setup.kp``)."""

    def __init__(self, instance_id, owner, start_time, constants):
        self.instance_id = instance_id
        self.owner = owner
        self.start_time = start_time
        for name, value in constants.items():
            setattr(self, name, value)


class _Description:
    """A program class's declarations, read once: its ports, memory, clock and generated helpers."""

    def __init__(self, cls):
        declarations = []
        for klass in reversed(cls.__mro__):
            for attribute, value in vars(klass).items():
                if isinstance(value, _Declaration):
                    declarations.append((value._order, attribute, value))
        seen = {}
        for order, attribute, value in sorted(declarations, key=lambda item: item[0]):
            seen[attribute] = value
        ordered = sorted(seen.items(), key=lambda item: item[1]._order)
        self.cls = cls
        self.name = cls.__name__
        self.node = issubclass(cls, Node)
        self.inputs = [value for _, value in ordered if isinstance(value, _Port)]
        self.outputs = [value for _, value in ordered if isinstance(value, Output)]
        self.memory = [value for _, value in ordered if isinstance(value, Memory)]
        clocks = [value for _, value in ordered if isinstance(value, Clock)]
        if len(clocks) > 1:
            raise TypeError(f"The program {self.name} declares more than one clock.")
        self.clock = clocks[0] if clocks else None
        for index, port in enumerate(self.inputs):
            port.index = index
        for index, port in enumerate(self.outputs):
            port.index = index
        offset = 0
        for field in self.memory:
            field.offset = offset
            offset += 8 * field.slots
        self.memory_size = offset
        self.input_attributes = [port.attribute for port in self.inputs]
        self.memory_attributes = [field.attribute for field in self.memory]
        if not self.node and len(self.outputs) != 1:
            raise TypeError(
                f"The relationship program {self.name} declares {len(self.outputs)} outputs; a relationship has exactly one "
                "(a node program may have several)."
            )
        self.view_class = self._view_class()
        self.writer_class = self._writer_class()
        self.has_jacobian = getattr(cls, "jacobian", None) is not Program.jacobian
        self.has_advance = getattr(cls, "advance", None) is not Program.advance

    def describe(self):
        """The description the engine reads (the in-process ABI's JSON shape)."""
        description = {
            "name": self.name,
            "kind": "node" if self.node else "relationship",
            "inputs": [],
            "outputs": [],
            "memory": [],
            "memorySize": self.memory_size,
            "clockPeriod": 0.0,
        }
        for port in self.inputs:
            entry = {"key": port.key, "kind": port.kind, "unit": port.unit}
            if port.default is not None:
                entry["default"] = port.default
            description["inputs"].append(entry)
        by_attribute = {port.attribute: port for port in self.inputs}
        for port in self.outputs:
            entry = {"key": port.key, "unit": port.unit}
            if port.depends_on is not None:
                entry["dependsOn"] = [by_attribute[name].key if name in by_attribute else _camel(name) for name in port.depends_on]
            description["outputs"].append(entry)
        for field in self.memory:
            description["memory"].append({"name": field.name, "type": field.type, "count": field.count, "offset": field.offset, "unit": field.unit})
        if self.clock is not None:
            if isinstance(self.clock.period, Constant):
                description["clockConstant"] = self.clock.period.key
            else:
                description["clockPeriod"] = float(self.clock.period)
        return description

    def _view_class(self):
        program = self.name
        known = self.input_attributes + self.memory_attributes
        namespace = {"__slots__": ("_v", "_m")}

        def refuse(name):
            def setter(view, value):
                raise AttributeError(
                    f"'{name}' cannot be changed through x: x is read-only. Memory changes only in advance(), through m "
                    f"(m.{name} = ...), and inputs are what the model gives."
                )

            return setter

        for index, attribute in enumerate(self.input_attributes):
            namespace[attribute] = property(lambda view, index=index: view._v[index], refuse(attribute))
        for field in self.memory:
            if field.type == "random":
                namespace[field.attribute] = property(lambda view, name=field.name: _Stream(view._m, name, False), refuse(field.attribute))
            elif field.type == "reals":
                namespace[field.attribute] = property(lambda view, name=field.name: tuple(view._m[name]), refuse(field.attribute))
            else:
                namespace[field.attribute] = property(lambda view, name=field.name: view._m[name], refuse(field.attribute))

        def missing(view, name):
            raise AttributeError(
                f"The program {program} reads '{name}', which is not one of its inputs or memory ({', '.join(known) or 'none declared'})."
            )

        namespace["__getattr__"] = missing
        return type(f"{program}Inputs", (), namespace)

    def _writer_class(self):
        program = self.name
        fields = {field.attribute: field for field in self.memory}
        namespace = {"__slots__": ("_m",)}
        for attribute, field in fields.items():
            if field.type == "random":
                namespace[attribute] = property(lambda writer, name=field.name: _Stream(writer._m, name, True))
                continue

            def getter(writer, name=field.name, kind=field.type):
                value = writer._m[name]
                return list(value) if kind == "reals" else value

            def setter(writer, value, name=field.name, kind=field.type, count=field.count):
                if kind == "real":
                    writer._m[name] = float(value)
                elif kind == "integer":
                    writer._m[name] = int(value)
                elif kind == "flag":
                    writer._m[name] = bool(value)
                else:
                    values = [float(item) for item in value]
                    if len(values) != count:
                        raise ValueError(f"The memory '{name}' holds {count} numbers, not {len(values)}.")
                    writer._m[name] = values

            namespace[attribute] = property(getter, setter)

        def missing(writer, name):
            raise AttributeError(f"The program {program} has no memory '{name}' ({', '.join(fields) or 'none declared'}).")

        def refuse_unknown(writer, name, value):
            if name in fields or name == "_m":
                object.__setattr__(writer, name, value)
                return
            raise AttributeError(
                f"The program {program} has no memory '{name}' to change; declare it as a class attribute, {name} = Memory(...)."
            )

        namespace["__getattr__"] = missing
        namespace["__setattr__"] = refuse_unknown
        return type(f"{program}Memory", (), namespace)

    # ── Memory as the engine keeps it: one 8-byte slot per number, in declaration order ─────────────────────────────────────────────

    def initial_memory(self, owner, program_seed):
        store = {}
        for field in self.memory:
            if field.type == "random":
                store[field.name] = [random_seed(owner, program_seed, field.name), 0]
            elif field.type == "reals":
                store[field.name] = list(field.initial)
            else:
                store[field.name] = field.initial
        return store

    def pack(self, store):
        parts = []
        for field in self.memory:
            value = store[field.name]
            if field.type == "real":
                parts.append(struct.pack("<d", value))
            elif field.type == "integer":
                parts.append(struct.pack("<q", value))
            elif field.type == "flag":
                parts.append(struct.pack("<B7x", 1 if value else 0))
            elif field.type == "reals":
                parts.append(struct.pack(f"<{field.count}d", *value))
            else:
                parts.append(struct.pack("<QQ", value[0] & _MASK, value[1] & _MASK))
        return b"".join(parts)

    def unpack(self, data):
        if len(data) != self.memory_size:
            raise ValueError(f"The program {self.name}'s memory is {self.memory_size} bytes, not {len(data)}.")
        store = {}
        for field in self.memory:
            at = field.offset
            if field.type == "real":
                store[field.name] = struct.unpack_from("<d", data, at)[0]
            elif field.type == "integer":
                store[field.name] = struct.unpack_from("<q", data, at)[0]
            elif field.type == "flag":
                store[field.name] = data[at] != 0
            elif field.type == "reals":
                store[field.name] = list(struct.unpack_from(f"<{field.count}d", data, at))
            else:
                store[field.name] = list(struct.unpack_from("<QQ", data, at))
        return store

    def view(self, values, store):
        view = object.__new__(self.view_class)
        object.__setattr__(view, "_v", values)
        object.__setattr__(view, "_m", store)
        return view

    def writer(self, store):
        writer = object.__new__(self.writer_class)
        object.__setattr__(writer, "_m", store)
        return writer


_DESCRIPTIONS = {}


def describe(cls):
    """The description of a program class, read once."""
    found = _DESCRIPTIONS.get(cls)
    if found is None:
        found = _DESCRIPTIONS[cls] = _Description(cls)
    return found


class Program:
    """The base of every version 2 program. Override initialize(), advance() and shutdown() as needed."""

    _frozen = False

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if cls.__name__ in ("Relationship", "Node") and cls.__module__ == __name__:
            return
        if issubclass(cls, Node):
            outputs = [value for klass in reversed(cls.__mro__) for value in vars(klass).values() if isinstance(value, Output)]
            outputs.sort(key=lambda port: port._order)
            names = [port.attribute for port in outputs]
            if names:
                parameters = ", ".join(names)
                source = f"def outputs(self, *, {parameters}):\n    return ({parameters},)\n"
                namespace = {}
                exec(source, namespace)  # noqa: S102 -- generated from the class's own identifiers: one keyword per declared output
                outputs_method = namespace["outputs"]
                outputs_method.__doc__ = f"The outputs of {cls.__name__}, every one by name: {', '.join(names)}."
                cls.outputs = outputs_method

    def __setattr__(self, name, value):
        if self._frozen:
            raise AttributeError(
                f"{type(self).__name__} cannot set '{name}' after initialize(): a program changes nothing in evaluate() or advance(). "
                f"Keep what it remembers in declared memory ({name} = Memory(...)) and change it in advance() through m."
            )
        object.__setattr__(self, name, value)

    def initialize(self, setup, m):
        """Once per instance, before the run and before a restore: may read constants (setup.kp), set attributes on self and memory's
        starting values through m."""

    def advance(self, step, x, m):
        """Once per accepted step, or at each clock tick: the only place memory changes."""

    def jacobian(self, t, x):
        """Optional: the derivatives of the outputs by the inputs, as {("output", "input"): value}. A stiff method uses them in place of
        differences; Check program compares them with differences."""
        return None

    def shutdown(self):
        """Once, after the run: release what initialize() took."""


class Relationship(Program):
    """One output: an interaction term on a relationship, or a node's own part. evaluate(t, x) returns its value."""

    def evaluate(self, t, x):
        raise NotImplementedError


class Node(Program):
    """Several outputs for one node. evaluate(t, x) returns self.outputs(name=value, ...)."""

    def evaluate(self, t, x):
        raise NotImplementedError


def _freeze(program):
    object.__setattr__(program, "_frozen", True)
