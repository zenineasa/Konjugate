# Copyright © 2026 Zenin Easa Panthakkalakath

"""Konjugate provider worker — runs a RelationshipProvider over the engine protocol.

Launch with:  python -m konjugate <provider_module_path>

The worker communicates with the engine using framed Protobuf-compatible binary
messages on stdin/stdout. It uses a hand-written wire-format codec so the SDK
remains standard-library-only.
"""

import importlib.util
import struct
import sys
from pathlib import Path

from konjugate import (
    EvaluationContext,
    InputView,
    OutputCollector,
    RelationshipProvider,
)

# ── Minimal protobuf wire-format helpers ─────────────────────────────────────


def _encode_varint(value):
    result = bytearray()
    while value > 0x7F:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    result.append(value & 0x7F)
    return bytes(result)


def _decode_varint(data, offset):
    value = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, offset
        shift += 7
        if shift >= 64:
            raise RuntimeError("Malformed varint in provider protocol.")
    raise RuntimeError("Truncated varint in provider protocol.")


def _encode_tag(field, wire_type):
    return _encode_varint((field << 3) | wire_type)


def _encode_length_delimited(field, payload):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    return _encode_tag(field, 2) + _encode_varint(len(payload)) + payload


def _encode_varint_field(field, value):
    return _encode_tag(field, 0) + _encode_varint(value)


def _encode_double_field(field, value):
    return _encode_tag(field, 1) + struct.pack("<d", value)


def _encode_bool_field(field, value):
    return _encode_varint_field(field, 1 if value else 0)


def _decode_fields(data):
    """Yield (field_number, wire_type, value) tuples from a protobuf message."""
    offset = 0
    while offset < len(data):
        tag, offset = _decode_varint(data, offset)
        field = tag >> 3
        wire = tag & 7
        if wire == 0:
            value, offset = _decode_varint(data, offset)
        elif wire == 1:
            value = struct.unpack_from("<d", data, offset)[0]
            offset += 8
        elif wire == 2:
            length, offset = _decode_varint(data, offset)
            value = data[offset : offset + length]
            offset += length
        elif wire == 5:
            value = data[offset : offset + 4]
            offset += 4
        else:
            raise RuntimeError(f"Unknown wire type {wire} in provider protocol.")
        yield field, wire, value


# ── Message decoders ─────────────────────────────────────────────────────────


def _decode_handshake_request(data):
    protocol_version = 0
    provider_api_version = 0
    for field, wire, value in _decode_fields(data):
        if field == 1 and wire == 0:
            protocol_version = value
        elif field == 2 and wire == 0:
            provider_api_version = value
    return protocol_version, provider_api_version


def _decode_provider_instance(data):
    instance_id = 0
    input_keys = []
    for field, wire, value in _decode_fields(data):
        if field == 1 and wire == 0:
            instance_id = value
        elif field == 2 and wire == 2:
            input_keys.append(value.decode("utf-8"))
    return instance_id, input_keys


def _decode_initialize_request(data):
    instances = []
    for field, wire, value in _decode_fields(data):
        if field == 1 and wire == 2:
            instances.append(_decode_provider_instance(value))
    return instances


def _decode_evaluation(data):
    instance_id = 0
    inputs = []
    for field, wire, value in _decode_fields(data):
        if field == 1 and wire == 0:
            instance_id = value
        elif field == 2 and wire == 2:
            count = len(value) // 8
            inputs = list(struct.unpack_from(f"<{count}d", value))
    return instance_id, inputs


def _decode_evaluate_batch_request(data):
    sequence = 0
    simulation_time = 0.0
    step_size = 0.0
    evaluations = []
    for field, wire, value in _decode_fields(data):
        if field == 1 and wire == 0:
            sequence = value
        elif field == 2 and wire == 1:
            simulation_time = value
        elif field == 3 and wire == 1:
            step_size = value
        elif field == 4 and wire == 2:
            evaluations.append(_decode_evaluation(value))
    return sequence, simulation_time, step_size, evaluations


def _decode_engine_to_provider(data):
    for field, wire, value in _decode_fields(data):
        if wire == 2:
            if field == 1:
                return "handshake", _decode_handshake_request(value)
            if field == 2:
                return "initialize", _decode_initialize_request(value)
            if field == 3:
                return "evaluateBatch", _decode_evaluate_batch_request(value)
            if field == 4:
                return "shutdown", None
    raise RuntimeError("Unrecognized EngineToProvider message.")


# ── Message encoders ─────────────────────────────────────────────────────────


def _encode_handshake_response(description):
    payload = b""
    payload += _encode_varint_field(1, 1)
    payload += _encode_varint_field(2, 1)
    payload += _encode_varint_field(3, 2)  # RUNTIME_KIND_PYTHON
    payload += _encode_length_delimited(4, description.provider_id)
    for inp in description.inputs:
        payload += _encode_length_delimited(5, inp.key)
    payload += _encode_length_delimited(6, description.output.key)
    return _encode_length_delimited(1, payload)


def _encode_initialize_response(instance_ids):
    packed = b""
    for iid in instance_ids:
        packed += _encode_varint(iid)
    payload = _encode_length_delimited(1, packed)
    return _encode_length_delimited(2, payload)


def _encode_evaluate_batch_response(sequence, contributions):
    payload = _encode_varint_field(1, sequence)
    for instance_id, value in contributions:
        contribution = _encode_varint_field(1, instance_id) + _encode_double_field(2, value)
        payload += _encode_length_delimited(2, contribution)
    return _encode_length_delimited(3, payload)


def _encode_shutdown_response():
    return _encode_length_delimited(4, b"")


def _encode_provider_failure(sequence, code, message, fatal):
    payload = b""
    payload += _encode_varint_field(1, sequence)
    payload += _encode_length_delimited(2, code)
    payload += _encode_length_delimited(3, message)
    payload += _encode_bool_field(4, fatal)
    return _encode_length_delimited(5, payload)


# ── Framed I/O ───────────────────────────────────────────────────────────────


def _read_exact(stream, count):
    data = b""
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def _read_framed(stream):
    header = _read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack(">I", header)[0]
    payload = _read_exact(stream, size)
    if payload is None:
        return None
    return payload


def _write_framed(stream, message):
    stream.write(struct.pack(">I", len(message)))
    stream.write(message)
    stream.flush()


# ── Worker lifecycle ─────────────────────────────────────────────────────────


def _load_provider_class(module_path):
    spec = importlib.util.spec_from_file_location("_konjugate_user_provider", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load provider module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in dir(module):
        obj = getattr(module, name)
        if (
            isinstance(obj, type)
            and issubclass(obj, RelationshipProvider)
            and obj is not RelationshipProvider
        ):
            return obj()
    raise RuntimeError(f"No RelationshipProvider subclass found in {module_path}")


def _run_worker(provider, stdin_stream, stdout_stream):
    description = provider.describe()
    instance_bindings = {}
    initialized = False

    while True:
        raw = _read_framed(stdin_stream)
        if raw is None:
            break

        kind, data = _decode_engine_to_provider(raw)

        if kind == "handshake":
            protocol_version, api_version = data
            if protocol_version != 1 or api_version != 1:
                _write_framed(
                    stdout_stream,
                    _encode_provider_failure(
                        0, "versionMismatch",
                        "This provider supports protocol version 1 and API version 1.",
                        True,
                    ),
                )
                return 1
            _write_framed(stdout_stream, _encode_handshake_response(description))

        elif kind == "initialize":
            instances = data
            initialized_ids = []
            for instance_id, input_keys in instances:
                key_map = {inp.key: i for i, inp in enumerate(description.inputs)}
                key_indexes = []
                for key in input_keys:
                    if key not in key_map:
                        _write_framed(
                            stdout_stream,
                            _encode_provider_failure(
                                0, "unknownInputKey",
                                f"Instance binding references unknown input key: {key}",
                                True,
                            ),
                        )
                        return 1
                    key_indexes.append(key_map[key])
                instance_bindings[instance_id] = (input_keys, key_indexes)
                provider.initialize(type("InitializationContext", (), {"instance_id": instance_id})())
                initialized_ids.append(instance_id)
            initialized = True
            _write_framed(stdout_stream, _encode_initialize_response(initialized_ids))

        elif kind == "evaluateBatch":
            if not initialized:
                sequence = data[0]
                _write_framed(
                    stdout_stream,
                    _encode_provider_failure(
                        sequence, "notInitialized",
                        "Evaluation received before initialization.",
                        True,
                    ),
                )
                return 1
            sequence, simulation_time, step_size, evaluations = data
            contributions = []
            for instance_id, raw_inputs in evaluations:
                binding = instance_bindings.get(instance_id)
                if binding is None:
                    _write_framed(
                        stdout_stream,
                        _encode_provider_failure(
                            sequence, "unknownInstance",
                            "Evaluation references an uninitialized instance.",
                            True,
                        ),
                    )
                    return 1
                input_keys, key_indexes = binding
                input_count = len(description.inputs)
                ordered_values = [0.0] * input_count
                for i, key_index in enumerate(key_indexes):
                    if i < len(raw_inputs):
                        ordered_values[key_index] = raw_inputs[i]
                input_dict = {
                    description.inputs[i].key: ordered_values[i] for i in range(input_count)
                }
                output = OutputCollector()
                provider.evaluate(
                    EvaluationContext(simulation_time, step_size),
                    InputView(input_dict),
                    output,
                )
                contributions.append((instance_id, output.gradient))
            _write_framed(
                stdout_stream,
                _encode_evaluate_batch_response(sequence, contributions),
            )

        elif kind == "shutdown":
            provider.shutdown()
            _write_framed(stdout_stream, _encode_shutdown_response())
            return 0

    provider.shutdown()
    return 0


def main():
    if len(sys.argv) < 2:
        print("Usage: python -m konjugate <provider_module.py>", file=sys.stderr)
        return 1

    module_path = str(Path(sys.argv[1]).resolve())
    stdin_stream = sys.stdin.buffer
    stdout_stream = sys.stdout.buffer

    try:
        provider = _load_provider_class(module_path)
    except Exception as error:
        _write_framed(
            stdout_stream,
            _encode_provider_failure(0, "factoryFailed", str(error), True),
        )
        return 1

    try:
        return _run_worker(provider, stdin_stream, stdout_stream)
    except Exception as error:
        try:
            _write_framed(
                stdout_stream,
                _encode_provider_failure(0, "workerFailure", str(error), True),
            )
        except Exception:
            pass
        try:
            provider.shutdown()
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
