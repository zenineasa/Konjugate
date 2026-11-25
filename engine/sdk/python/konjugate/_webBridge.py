# Copyright © 2026 Zenin Easa Panthakkalakath

"""Web edition bridge -- called directly by Pyodide from src/webPythonProviderBridge.mjs, in
place of __main__.py's stdin/stdout pipe loop (which has no meaning inside a single WASM
address space: there is no separate provider process to frame messages to). This module
reuses __main__.py's own _load_provider_class and per-message handlers unchanged -- the
handshake/protocol-version negotiation those exist for a real subprocess to perform is skipped
here entirely, since there is no separate process to negotiate with; a construction failure
(e.g. no provider subclass found) simply raises, propagating as an exception across the
Emscripten JS boundary the same way any other engine error does.

Wire shape is plain JSON (not the protobuf framing __main__.py speaks), one dict in, one dict
out, always {"ok": true, ...} or {"ok": false, "code", "message", "fatal"} -- see
engine/src/providerRuntime.cpp's WasmPyodideProviderBackend for the C++ side of this contract.
"""

import base64
import json

from konjugate.__main__ import (
    ProviderProtocolError,
    _is_version2_source,
    _load_provider_class,
    handle_checkpoint,
    handle_evaluate_batch,
    handle_initialize,
    handle_node_evaluate,
    handle_restore,
)


def _int(value):
    # boost::property_tree's JSON writer (the C++ side of this bridge) quotes every leaf value
    # as a string, since ptree itself has no numeric type -- {"instanceId": "1"}, not
    # {"instanceId": 1}. Tolerating either form here means neither side has to special-case its
    # own JSON encoding around the other's limitations.
    return int(value)


def _float(value):
    return float(value)


class WebProviderBridge:
    def created_json(self):
        return json.dumps({"ok": True})

    def __init__(self, provider):
        self._provider = provider
        self._description = provider.describe()
        self._instance_bindings = {}
        self._initialized = False

    def dispatch_json(self, request_json):
        request = json.loads(request_json)
        kind = request["kind"]
        try:
            if kind == "initialize":
                instances = [(_int(instance["instanceId"]), instance["inputKeys"]) for instance in request["instances"]]
                ids = handle_initialize(self._provider, self._description, self._instance_bindings, instances)
                self._initialized = True
                return json.dumps({"ok": True, "initializedIds": ids, "inputKeys": [inp.key for inp in self._description.inputs]})

            if kind == "evaluateBatch":
                evaluations = [(_int(item["instanceId"]), [_float(v) for v in item["inputs"]]) for item in request["evaluations"]]
                contributions = handle_evaluate_batch(
                    self._provider, self._description, self._instance_bindings, self._initialized,
                    _int(request["sequence"]), _float(request["simulationTime"]), _float(request["stepSize"]), evaluations,
                )
                return json.dumps({"ok": True, "contributions": [{"instanceId": i, "value": v} for i, v in contributions]})

            if kind == "evaluateNode":
                evaluations = [(_int(item["instanceId"]), [_float(v) for v in item["inputs"]]) for item in request["evaluations"]]
                contributions = handle_node_evaluate(
                    self._provider, self._description, self._instance_bindings,
                    _float(request["simulationTime"]), _float(request["stepSize"]), evaluations,
                )
                return json.dumps({"ok": True, "contributions": [{"instanceId": i, "outputs": o} for i, o in contributions]})

            if kind == "checkpoint":
                payload = handle_checkpoint(self._provider, self._instance_bindings, _int(request["instanceId"]))
                return json.dumps({"ok": True, "payloadBase64": base64.b64encode(payload).decode("ascii")})

            if kind == "restore":
                payload = base64.b64decode(request["payloadBase64"])
                handle_restore(self._provider, self._instance_bindings, _int(request["instanceId"]), payload)
                return json.dumps({"ok": True})

            if kind == "shutdown":
                self._provider.shutdown()
                return json.dumps({"ok": True})

            raise RuntimeError(f"Unknown web provider bridge request kind: {kind}")
        except ProviderProtocolError as error:
            return json.dumps({"ok": False, "code": error.code, "message": error.message, "fatal": error.fatal})
        except Exception as error:  # noqa: BLE001 -- deliberately broad, mirrors __main__.py's own top-level catch-and-report
            return json.dumps({"ok": False, "code": "workerFailure", "message": str(error), "fatal": True})


class WebProgramBridge:
    """A version 2 program (konjugate.v2), served with the same ProgramHost the native worker uses (konjugate/v2/_host.py); memory as
    base64. See WebProgramTransport in engine/src/providerRuntime.cpp for the C++ side."""

    def __init__(self, module_path):
        from konjugate.v2._host import ProgramHost, load_program_class

        # A program that cannot be loaded is answered as the native worker answers it (its factoryFailed message, the error's own
        # words), not raised: raised, it would reach the engine as Pyodide's whole traceback.
        self._failure = None
        try:
            self._host = ProgramHost(load_program_class(module_path, f"_konjugate_web_program_{abs(hash(module_path))}"), module_path)
        except Exception as error:  # noqa: BLE001 -- reported to the engine, as __main__.py reports it
            self._failure = str(error)

    def created_json(self):
        if self._failure is not None:
            return json.dumps({"ok": False, "code": "factoryFailed", "message": self._failure, "fatal": True})
        return json.dumps({"ok": True, "description": json.dumps(self._host.describe())})

    @staticmethod
    def _outcomes(outcomes):
        return [
            {
                "instanceId": outcome["instanceId"],
                "outputs": [repr(value) if value != value or value in (float("inf"), float("-inf")) else value for value in outcome.get("outputs") or []],
                "status": outcome.get("status", 0),
                "message": outcome.get("message", ""),
                "line": outcome.get("line", 0),
                "memoryBase64": base64.b64encode(outcome.get("memory") or b"").decode("ascii"),
                "clockPeriod": outcome.get("clockPeriod", 0.0),
            }
            for outcome in outcomes
        ]

    def dispatch_json(self, request_json):
        request = json.loads(request_json)
        kind = request["kind"]
        try:
            calls = [(_int(item["instanceId"]), [_float(value) for value in item.get("values", [])], bool(_int(item.get("first", 0))))
                     for item in request.get("calls", [])]
            if kind == "programInitialize":
                instances = [(_int(item["instanceId"]), item.get("owner", ""), _float(item.get("startTime", 0)), [_float(value) for value in item.get("values", [])],
                              [_int(flag) for flag in item.get("bound", [])], _int(item.get("ownerId", 0)), _int(item.get("programSeed", 0)))
                             for item in request.get("instances", [])]
                return json.dumps({"ok": True, "outcomes": self._outcomes(self._host.initialize(instances))})
            if kind == "programEvaluate":
                return json.dumps({"ok": True, "outcomes": self._outcomes(self._host.evaluate(_float(request["time"]), [(i, v) for i, v, _ in calls]))})
            if kind == "programAdvance":
                return json.dumps({"ok": True, "outcomes": self._outcomes(self._host.advance(_float(request["time"]), _float(request["size"]), calls))})
            if kind == "programJacobian":
                return json.dumps({"ok": True, "outcomes": self._outcomes(self._host.jacobian(_float(request["time"]), [(i, v) for i, v, _ in calls]))})
            if kind == "programSetMemory":
                self._host.set_memory([(_int(item["instanceId"]), base64.b64decode(item.get("memoryBase64", ""))) for item in request.get("memories", [])])
                return json.dumps({"ok": True, "outcomes": []})
            if kind == "shutdown":
                self._host.shutdown()
                return json.dumps({"ok": True})
            raise RuntimeError(f"Unknown web program bridge request kind: {kind}")
        except Exception as error:  # noqa: BLE001 -- reported to the engine, which names the program
            return json.dumps({"ok": False, "code": "workerFailure", "message": str(error), "fatal": True})


def create_bridge(module_path):
    if _is_version2_source(module_path):
        return WebProgramBridge(module_path)
    return WebProviderBridge(_load_provider_class(module_path))
