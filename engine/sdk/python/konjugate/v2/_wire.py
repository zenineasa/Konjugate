# Copyright © 2026 Zenin Easa Panthakkalakath

"""The pipe worker's version 2 messages (protocol/relationshipProvider.proto, the Program* messages), hand-coded as version 1's are so
the SDK stays standard-library only, and the worker loop that answers them with a ProgramHost."""

import json
import struct

from konjugate.__main__ import (
    _decode_fields,
    _encode_bool_field,
    _encode_double_field,
    _encode_length_delimited,
    _encode_provider_failure,
    _encode_varint,
    _encode_varint_field,
    _read_framed,
    _write_framed,
)


def _doubles(wire, value):
    if wire == 2:
        count = len(value) // 8
        return list(struct.unpack_from(f"<{count}d", value))
    return [value]


def _decode_instance(data):
    instance = {"instance_id": 0, "owner": "", "start_time": 0.0, "values": [], "bound": b"", "owner_id": 0, "program_seed": 0}
    for field, wire, value in _decode_fields(data):
        if field == 1 and wire == 0:
            instance["instance_id"] = value
        elif field == 2 and wire == 2:
            instance["owner"] = value.decode("utf-8")
        elif field == 3 and wire == 1:
            instance["start_time"] = value
        elif field == 4:
            instance["values"].extend(_doubles(wire, value))
        elif field == 5 and wire == 2:
            instance["bound"] = bytes(value)
        elif field == 6 and wire == 0:
            instance["owner_id"] = value
        elif field == 7 and wire == 0:
            instance["program_seed"] = value
    return instance


def _decode_call(data):
    instance_id, values, first = 0, [], False
    for field, wire, value in _decode_fields(data):
        if field == 1 and wire == 0:
            instance_id = value
        elif field == 2:
            values.extend(_doubles(wire, value))
        elif field == 3 and wire == 0:
            first = bool(value)
    return instance_id, values, first


def decode_request(field, data):
    """A version 2 EngineToProvider payload (fields 9 to 13) as (kind, values)."""
    if field == 9:
        return "programInitialize", [_decode_instance(value) for number, wire, value in _decode_fields(data) if number == 1 and wire == 2]
    if field in (10, 13):
        time, calls = 0.0, []
        for number, wire, value in _decode_fields(data):
            if number == 1 and wire == 1:
                time = value
            elif number == 2 and wire == 2:
                calls.append(_decode_call(value))
        return ("programEvaluate" if field == 10 else "programJacobian"), (time, calls)
    if field == 11:
        time, size, calls = 0.0, 0.0, []
        for number, wire, value in _decode_fields(data):
            if number == 1 and wire == 1:
                time = value
            elif number == 2 and wire == 1:
                size = value
            elif number == 3 and wire == 2:
                calls.append(_decode_call(value))
        return "programAdvance", (time, size, calls)
    if field == 12:
        memories = []
        for number, wire, value in _decode_fields(data):
            if number == 1 and wire == 2:
                instance_id, memory = 0, b""
                for inner, inner_wire, inner_value in _decode_fields(value):
                    if inner == 1 and inner_wire == 0:
                        instance_id = inner_value
                    elif inner == 2 and inner_wire == 2:
                        memory = bytes(inner_value)
                memories.append((instance_id, memory))
        return "programSetMemory", memories
    return None, None


def encode_response(outcomes):
    payload = b""
    for outcome in outcomes:
        item = _encode_varint_field(1, outcome["instanceId"])
        values = outcome.get("outputs") or []
        if values:
            item += _encode_length_delimited(2, struct.pack(f"<{len(values)}d", *values))
        if outcome.get("status"):
            item += _encode_varint_field(3, outcome["status"])
        if outcome.get("message"):
            item += _encode_length_delimited(4, outcome["message"])
        if outcome.get("line"):
            item += _encode_varint_field(5, outcome["line"])
        if outcome.get("memory"):
            item += _encode_length_delimited(6, outcome["memory"])
        if outcome.get("clockPeriod"):
            item += _encode_double_field(7, outcome["clockPeriod"])
        payload += _encode_length_delimited(1, item)
    return _encode_length_delimited(9, payload)


def encode_handshake(host):
    description = host.describe()
    payload = _encode_varint_field(1, 1) + _encode_varint_field(2, 2) + _encode_varint_field(3, 2)
    payload += _encode_length_delimited(4, description["name"])
    if description["kind"] == "node":
        payload += _encode_bool_field(7, True)
    payload += _encode_length_delimited(9, json.dumps(description))
    return _encode_length_delimited(1, payload)


def _raw_request(raw):
    for field, wire, value in _decode_fields(raw):
        if wire == 2:
            return field, value
    raise RuntimeError("Unrecognized EngineToProvider message.")


def dispatch(host, kind, data):
    """One decoded version 2 request answered by the host, as outcomes."""
    if kind == "programInitialize":
        return host.initialize([
            (item["instance_id"], item["owner"], item["start_time"], item["values"], list(item["bound"]), item["owner_id"], item["program_seed"])
            for item in data
        ])
    if kind == "programEvaluate":
        time, calls = data
        return host.evaluate(time, [(instance_id, values) for instance_id, values, _ in calls])
    if kind == "programAdvance":
        time, size, calls = data
        return host.advance(time, size, calls)
    if kind == "programJacobian":
        time, calls = data
        return host.jacobian(time, [(instance_id, values) for instance_id, values, _ in calls])
    if kind == "programSetMemory":
        host.set_memory(data)
        return []
    raise RuntimeError(f"Unknown version 2 request: {kind}")


def run_worker(host, stdin_stream, stdout_stream):
    while True:
        raw = _read_framed(stdin_stream)
        if raw is None:
            break
        field, data = _raw_request(raw)
        if field == 1:
            protocol_version, api_version = 0, 0
            for number, wire, value in _decode_fields(data):
                if number == 1 and wire == 0:
                    protocol_version = value
                elif number == 2 and wire == 0:
                    api_version = value
            if protocol_version != 1 or api_version != 2:
                _write_framed(stdout_stream, _encode_provider_failure(
                    0, "versionMismatch",
                    f"This program is written for version 2 of the program SDK, but the engine asked for version {api_version}.", True))
                return 1
            _write_framed(stdout_stream, encode_handshake(host))
            continue
        if field == 4:
            host.shutdown()
            _write_framed(stdout_stream, _encode_length_delimited(4, b""))
            return 0
        kind, decoded = decode_request(field, data)
        if kind is None:
            _write_framed(stdout_stream, _encode_provider_failure(
                0, "wrongProviderKind", "This worker serves a version 2 program, which answers only version 2 requests.", True))
            return 1
        _write_framed(stdout_stream, encode_response(dispatch(host, kind, decoded)))
    host.shutdown()
    return 0


__all__ = ["decode_request", "dispatch", "encode_response", "run_worker", "_encode_varint"]
