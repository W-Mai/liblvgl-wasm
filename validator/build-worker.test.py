"""Check trusted feature worker inputs and atomic publication."""

import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "target/validator/generated/helper-data.json"
BUILDER = ROOT / "validator/build-worker.sh"
spec = importlib.util.spec_from_file_location("validator_build_worker", ROOT / "validator/build-worker.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class WorkerBuildTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="worker-test-", dir=ROOT / "target/validator")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.data = self.root / "untrusted.json"
        self.output = self.root / "feature-validator.js"
        self.data.write_bytes(DATA.read_bytes())

    def build(self, env=None):
        return subprocess.run(["sh", BUILDER, self.output], cwd=ROOT,
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_forged_helper_with_self_reported_policy_is_not_an_input(self):
        data = json.loads(self.data.read_bytes())
        names = bytearray()
        table = bytearray()
        for feature in data["features"]:
            encoded = feature["name"].encode("ascii")
            table.extend(struct.pack("<III", 4096 + len(names), len(encoded), feature["mask"]))
            names.extend(encoded)
        escape = lambda values: "".join(f"\\{byte:02x}" for byte in values)
        wat = f'''(module
          (memory (export "memory") 32 4096)
          (data (i32.const 2048) "{escape(table)}")
          (data (i32.const 4096) "{escape(names)}")
          (func (export "lvw_reserve") (param i32) (result i32) i32.const 65536)
          (func (export "lvw_validate") (param i32) (result i32) i32.const 0)
          (func (export "lvw_release") (result i32) i32.const 1)
          (func (export "lvw_policy_version") (result i32) i32.const {data["policyVersion"]})
          (func (export "lvw_feature_count") (result i32) i32.const {len(data["features"])})
          (func (export "lvw_feature_name_length") (param i32) (result i32)
            local.get 0 i32.const 12 i32.mul i32.const 2048 i32.add i32.load offset=4)
          (func (export "lvw_feature_mask") (param i32) (result i32)
            local.get 0 i32.const 12 i32.mul i32.const 2048 i32.add i32.load offset=8)
          (func (export "lvw_feature_name_byte") (param i32 i32) (result i32)
            local.get 0 i32.const 12 i32.mul i32.const 2048 i32.add i32.load
            local.get 1 i32.add i32.load8_u))'''
        fake = self.root / "fake.wasm"
        subprocess.run([os.environ.get("WASM_TOOLS", "wasm-tools"), "parse", "-o", fake, "-"], input=wat, text=True, check=True)
        module = fake.read_bytes()
        data["helperBase64"] = base64.b64encode(module).decode("ascii")
        data["helperSha256"] = hashlib.sha256(module).hexdigest()
        self.data.write_text(json.dumps(data))
        policy = self.root / "policy.json"
        policy.write_text(json.dumps({"policyVersion": data["policyVersion"], "features": data["features"]}))
        subprocess.run(["bun", ROOT / "validator/verify-policy.ts", fake, policy], cwd=ROOT, check=True)
        script = "const m = new WebAssembly.Module(await Bun.file(Bun.argv[1]).bytes()); if (new WebAssembly.Instance(m).exports.lvw_validate(0) !== 0) throw Error('unexpected')"
        subprocess.run(["bun", "-e", script, fake], cwd=ROOT, check=True)
        self.output.write_bytes(b"previous")
        result = subprocess.run(["sh", BUILDER, self.data, self.output], cwd=ROOT, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_bytes(), b"previous")

    def test_failed_build_and_lock_conflict_preserve_publication_boundary(self):
        self.output.write_bytes(b"previous")
        compiler = self.root / "failed-rustc"
        compiler.write_text("#!/bin/sh\nexit 1\n")
        compiler.chmod(0o755)
        self.assertNotEqual(self.build({**os.environ, "RUSTC": str(compiler)}).returncode, 0)
        self.assertFalse(self.output.exists())
        self.output.write_bytes(b"previous")
        lock_path = self.output.with_name(f".{self.output.name}.lock")
        with lock_path.open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(self.build().returncode, 0)
            self.assertEqual(self.output.read_bytes(), b"previous")

        existing = self.root / "existing sdk"
        existing.mkdir()
        marker = existing / "marker"
        marker.write_bytes(b"preserved")
        result = subprocess.run(["sh", BUILDER, "--sdk-dir", existing], cwd=ROOT, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(marker.read_bytes(), b"preserved")

    def test_sdk_compiler_and_dependency_identity_are_enforced(self):
        manifest = json.loads((ROOT / "third_party/validator/manifest.json").read_text())
        good = ("rustc 1.92.0 (ded5c06cf 2025-12-08)\n"
                "commit-hash: ded5c06cf21d2b93bffd5d884aa6e96934ee4234\n"
                "host: x86_64-unknown-linux-gnu\nrelease: 1.92.0\n")
        self.assertEqual(builder.compiler_identity(good, manifest), "x86_64-unknown-linux-gnu")
        with self.assertRaisesRegex(ValueError, "compiler identity"):
            builder.compiler_identity(good.replace("ded5c06cf21d2b93bffd5d884aa6e96934ee4234", "0" * 40), manifest)
        with self.assertRaisesRegex(ValueError, "compiler identity"):
            builder.compiler_identity(good.replace("release: 1.92.0", "release: 1.93.0"), manifest)
        node = self.root / "node_modules/unlisted"
        node.mkdir(parents=True)
        (node / "extra.js").write_text("export const x = 1")
        metadata = self.root / "metafile.json"
        metadata.write_text(json.dumps({"outputs": {"bundle.js": {"imports": [], "inputs": {
            "node_modules/unlisted/extra.js": {"bytesInOutput": 1}}}}}))
        with self.assertRaisesRegex(ValueError, "unexpected feature bundle dependency"):
            builder.audit_metafile(metadata, self.root, manifest["noble"])

    def test_staging_policy_change_cannot_publish_mismatched_worker(self):
        real_bun = shutil.which("bun")
        self.assertIsNotNone(real_bun)
        tamper = self.root / "tamper.py"
        tamper.write_text(
            "import pathlib, sys\n"
            "path = pathlib.Path(sys.argv[1])\n"
            "source = path.read_text()\n"
            "updated = source.replace('[\\\"bulk-memory\\\", 1]', '[\\\"bulk-memory\\\", 32]')\n"
            "updated = updated.replace('[\\\"simd\\\", 32]', '[\\\"simd\\\", 1]')\n"
            "assert source != updated\n"
            "path.write_text(updated)\n"
        )
        wrapper = self.root / "bun"
        wrapper.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = build ] && [ \"$2\" = bindings/typescript/src/feature-validator-worker.ts ]; then\n"
            "    \"$LVW_REAL_BUN\" \"$@\" || exit $?\n"
            "    previous=\n"
            "    for argument in \"$@\"; do\n"
            "        if [ \"$previous\" = --outfile ]; then cp \"$argument\" \"$LVW_CAPTURE_WORKER\"; break; fi\n"
            "        previous=$argument\n"
            "    done\n"
            "    python3 \"$LVW_TAMPER_SCRIPT\" \"$PWD/target/validator/generated/helper-data.ts\"\n"
            "else\n"
            "    exec \"$LVW_REAL_BUN\" \"$@\"\n"
            "fi\n"
        )
        wrapper.chmod(0o755)
        env = {**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
               "LVW_REAL_BUN": real_bun, "LVW_TAMPER_SCRIPT": str(tamper), "LVW_CAPTURE_WORKER": str(self.root / "worker.js")}
        result = self.build(env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"feature helper data changed during worker build", result.stderr)
        self.assertFalse(self.output.exists())
        script = '''
const source = await Bun.file(Bun.argv[1]).text();
async function check(declaredFeatures, allowedFeatures, mask, accepted) {
  const url = URL.createObjectURL(new Blob([source], {type: "text/javascript"}));
  const worker = new Worker(url);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("worker timeout")), 10000);
      let sent = false;
      worker.onerror = event => { clearTimeout(timer); reject(Error(event.message)); };
      worker.onmessage = event => {
        if (!sent && event.data.type === "ready") {
          sent = true;
          const bytes = new Uint8Array([0,97,115,109,1,0,0,0]).buffer;
          worker.postMessage({bytes, mask, declaredFeatures, allowedFeatures}, [bytes]);
        } else {
          clearTimeout(timer);
          if (!sent) return reject(Error("worker failed before request"));
          if (accepted && event.data.type === "result" && event.data.accepted === true) resolve();
          else if (!accepted && event.data.type === "failure" && event.data.code === "helper-failed") resolve();
          else reject(Error("unexpected policy result"));
        }
      };
    });
  } finally { worker.terminate(); URL.revokeObjectURL(url); }
}
await check([], [], 0, true);
await check(["simd"], ["simd"], 1, false);
await check(["simd"], [], 32, false);
await check(["simd", "simd"], ["simd"], 32, false);
await check(["unknown"], ["unknown"], 1, false);
'''
        subprocess.run([real_bun, "-e", script, self.root / "worker.js"], cwd=ROOT, check=True)


if __name__ == "__main__":
    unittest.main()
