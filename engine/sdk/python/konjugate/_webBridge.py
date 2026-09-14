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
                return json.dumps({"ok": True, "initializedIds": ids})

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


def create_bridge(module_path):
    return WebProviderBridge(_load_provider_class(module_path))
