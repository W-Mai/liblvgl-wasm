"""Generate validator data from an owned Wasm snapshot."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "generator"))
from wasm import Reader, read_module  # noqa: E402

MAX_HELPER_BYTES = 16 * 1024 * 1024
BOOTSTRAP_FEATURES = "wasm1,bulk-memory,reference-types,sign-extension"


def object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate policy metadata field: {key}")
        result[key] = value
    return result


def policy_metadata(path):
    data = json.loads(path.read_bytes(), object_pairs_hook=object_without_duplicates)
    if not isinstance(data, dict) or set(data) != {"policyVersion", "features"} or data["policyVersion"] != 1 or type(data["policyVersion"]) is not int:
        raise ValueError("unsupported feature policy metadata")
    features = data["features"]
    if not isinstance(features, list) or not 1 <= len(features) <= 32:
        raise ValueError("invalid feature policy entries")
    names, bits = set(), 0
    for item in features:
        if not isinstance(item, dict) or set(item) != {"name", "mask"}:
            raise ValueError("invalid feature policy entry")
        name, mask = item["name"], item["mask"]
        if not isinstance(name, str) or re.fullmatch(r"[a-z][a-z0-9-]*", name) is None or name in names:
            raise ValueError("invalid or duplicate feature name")
        if type(mask) is not int or not 0 < mask <= 0x80000000 or mask & (mask - 1) or bits & mask:
            raise ValueError("invalid or duplicate feature mask")
        names.add(name)
        bits |= mask
    return data


def inspect_helper_structure(snapshot):
    reader = Reader(snapshot, "validator helper")
    if bytes(reader.take(8)) != b"\0asm\x01\0\0\0":
        raise ValueError("invalid validator helper header")
    while reader.position < len(reader.data):
        section = reader.byte()
        size = reader.u32()
        reader.take(size)
        if section == 8:
            raise ValueError("validator helper must not have a start section")
    module = read_module(snapshot)
    if module["imports"]:
        raise ValueError("validator helper must not import host resources")
    if module["memories"] != [{"minimum_pages": 32, "maximum_pages": 4096, "shared": False, "imported": False}]:
        raise ValueError("validator helper memory limits do not match")
    required = {
        "memory": {"kind": "memory", "index": 0},
        "lvw_reserve": {"kind": "function", "signature": {"params": ["i32"], "results": ["i32"]}},
        "lvw_validate": {"kind": "function", "signature": {"params": ["i32"], "results": ["i32"]}},
        "lvw_release": {"kind": "function", "signature": {"params": [], "results": ["i32"]}},
        "lvw_policy_version": {"kind": "function", "signature": {"params": [], "results": ["i32"]}},
        "lvw_feature_count": {"kind": "function", "signature": {"params": [], "results": ["i32"]}},
        "lvw_feature_name_length": {"kind": "function", "signature": {"params": ["i32"], "results": ["i32"]}},
        "lvw_feature_name_byte": {"kind": "function", "signature": {"params": ["i32", "i32"], "results": ["i32"]}},
        "lvw_feature_mask": {"kind": "function", "signature": {"params": ["i32"], "results": ["i32"]}},
    }
    for name, expected in required.items():
        if module["exports"].get(name) != expected:
            raise ValueError(f"validator helper export does not match: {name}")


def inspect_helper(snapshot):
    inspect_helper_structure(snapshot)
    subprocess.run([os.environ.get("WASM_TOOLS", "wasm-tools"), "validate", f"--features={BOOTSTRAP_FEATURES}", "-"], input=snapshot, check=True)


def generate(helper, metadata, output):
    if output.resolve() in (helper.resolve(), metadata.resolve()):
        raise ValueError("validator data output overlaps an input")
    output.unlink(missing_ok=True)
    with helper.open("rb") as source:
        snapshot = source.read(MAX_HELPER_BYTES + 1)
    if len(snapshot) > MAX_HELPER_BYTES:
        raise ValueError("validator helper exceeds input limit")
    inspect_helper(snapshot)
    policy = policy_metadata(metadata)
    encoded = base64.b64encode(snapshot).decode("ascii")
    digest = hashlib.sha256(snapshot).hexdigest()
    content = json.dumps({"helperBase64": encoded, "helperSha256": digest,
                          "policyVersion": policy["policyVersion"], "features": policy["features"]},
                         separators=(",", ":")) + "\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=output.parent, prefix=".helper-data-", delete=False) as staged:
        temporary = Path(staged.name)
        try:
            staged.write(content)
            staged.close()
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: generate-data.py HELPER_WASM POLICY_JSON OUTPUT_JSON")
    generate(*(Path(argument) for argument in sys.argv[1:]))
