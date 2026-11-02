"""Verify that a bounded-table core differs from its checked baseline only in table limits."""

import hashlib
import json
from pathlib import Path

from bindings import IDENTITY_KEYS, inventory
from wasm import Reader


MAX_CORE_BYTES = 64 * 1024 * 1024
MAX_API_BYTES = 32 * 1024 * 1024


def read(path: Path, limit: int) -> bytes:
    with path.open("rb") as source:
        value = source.read(limit + 1)
    if len(value) > limit:
        raise ValueError(f"input exceeds limit: {path}")
    return value


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def check_proof(api_bytes: bytes, wasm_bytes: bytes, proof_bytes: bytes) -> None:
    identity = json.loads(proof_bytes)
    if (not isinstance(identity, dict) or set(identity) != IDENTITY_KEYS
            or type(identity["schema_version"]) is not int or identity["schema_version"] != 1
            or identity["api_sha256"] != digest(api_bytes) or identity["wasm_sha256"] != digest(wasm_bytes)):
        raise ValueError("signature proof does not match its inputs")
    inventory(json.loads(api_bytes), identity)


def sections(data: bytes) -> tuple[list[bytes], bytes]:
    reader = Reader(data, "core")
    if bytes(reader.take(8)) != b"\0asm\x01\0\0\0":
        raise ValueError("invalid core header")
    standard = []
    seen = set()
    table = None
    while reader.position < len(reader.data):
        start = reader.position
        kind = reader.byte()
        payload = bytes(reader.take(reader.u32()))
        if kind == 0:
            continue
        if kind not in range(1, 14) or kind in seen:
            raise ValueError("unknown or duplicate standard section")
        seen.add(kind)
        if kind == 4:
            table = payload
        else:
            standard.append(bytes(reader.data[start:reader.position]))
    if table is None:
        raise ValueError("missing table section")
    return standard, table


def table(data: bytes, bounded: bool) -> int:
    reader = Reader(data, "table")
    if reader.u32() != 1 or reader.byte() != 0x70:
        raise ValueError("expected exactly one funcref table")
    if reader.byte() != int(bounded):
        raise ValueError("unexpected table limit flags")
    minimum = reader.u32()
    if bounded and reader.u32() != minimum:
        raise ValueError("bounded table maximum differs from its minimum")
    reader.finish()
    return minimum
