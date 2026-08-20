# Copyright © 2026 Zenin Easa Panthakkalakath

"""Protocol smoke test for the checkpointable Python NodeProvider worker."""

import os
import struct
import subprocess
import sys
from pathlib import Path

from konjugate.__main__ import _decode_engine_to_provider, _decode_fields, _encode_length_delimited, _encode_varint, _encode_varint_field


def frame(payload):
    return struct.pack(">I", len(payload)) + payload


def double_field(field, value):
    return _encode_varint((field << 3) | 1) + struct.pack("<d", value)


def message(field, payload):
    return _encode_length_delimited(field, payload)


def packed_doubles(field, values):
    return _encode_length_delimited(field, b"".join(struct.pack("<d", value) for value in values))


def read_frame(stream):
    header = stream.read(4)
    assert len(header) == 4
    size = struct.unpack(">I", header)[0]
    payload = stream.read(size)
    assert len(payload) == size
    return _decode_engine_to_provider(payload)


def read_response(stream):
    header = stream.read(4)
    assert len(header) == 4
    size = struct.unpack(">I", header)[0]
    payload = stream.read(size)
    assert len(payload) == size
    fields = list(_decode_fields(payload))
    assert fields and fields[0][0] in {1, 2, 3, 4, 5, 6, 7, 8}
    return fields[0][0], fields[0][2]


def send(process, payload):
    process.stdin.write(frame(payload))
    process.stdin.flush()
    return read_frame(process.stdout)


def send_response(process, payload):
    process.stdin.write(frame(payload))
    process.stdin.flush()
    return read_response(process.stdout)


def main():
    root = Path(__file__).resolve().parents[2]
    provider = root / "examples" / "providers" / "accumulatorNode.py"
    environment = {**os.environ, "PYTHONPATH": str(root / "engine" / "sdk" / "python")}
    process = subprocess.Popen(
        [sys.executable, "-m", "konjugate", str(provider)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    try:
        handshake = message(1, _encode_varint_field(1, 1) + _encode_varint_field(2, 1))
        assert send_response(process, handshake)[0] == 1

        initialize = message(2, message(1, _encode_varint_field(1, 7) + _encode_length_delimited(2, "input")))
        assert send_response(process, initialize)[0] == 2

        evaluation = _encode_varint_field(1, 7) + packed_doubles(2, [4.0])
        node_evaluate = message(
            6,
            _encode_varint_field(1, 1) + double_field(2, 0.0) + double_field(3, 0.5) + message(4, evaluation),
        )
        response_field, _ = send_response(process, node_evaluate)
        assert response_field == 6

        checkpoint_field, checkpoint_payload = send_response(process, message(7, _encode_varint_field(1, 7)))
        checkpoint_fields = {field: value for field, wire, value in _decode_fields(checkpoint_payload)}
        assert checkpoint_field == 7 and checkpoint_fields[1] == 7 and len(checkpoint_fields[2]) == 8

        restore = message(8, _encode_varint_field(1, 7) + _encode_length_delimited(2, checkpoint_fields[2]))
        assert send_response(process, restore)[0] == 8
        assert send_response(process, message(4, b""))[0] == 4
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


if __name__ == "__main__":
    main()
    print("NodeProvider worker protocol passed")
