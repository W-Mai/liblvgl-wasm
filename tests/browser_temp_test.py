"""Check Chromium uses a private short directory independently of TMPDIR."""

import hashlib
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import feature_sdk_browser
import package_browser


class BrowserTempPaths(unittest.TestCase):
    def test_both_browser_entrypoints_ignore_long_tmpdir(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            package = root / "package"
            core = package / "host-sdk/runtime/liblvgl.wasm"
            api = package / "host-sdk/metadata/api.json"
            core.parent.mkdir(parents=True)
            api.parent.mkdir(parents=True)
            core.write_bytes(b"core")
            api.write_bytes(b"api")
            identity = {"wasm_sha256": hashlib.sha256(b"core").hexdigest(),
                        "api_sha256": hashlib.sha256(b"api").hexdigest()}
            work = root / "work"
            work.mkdir()
            process = Mock()
            seen = []

            def launch(args, **kwargs):
                directory = Path(kwargs["env"]["TMPDIR"])
                self.assertEqual(directory.parent, Path("/tmp"))
                self.assertTrue(directory.is_dir())
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                self.assertIn("--user-data-dir=" + str(directory / "profile"), args)
                seen.append(directory)
                return process

            http = SimpleNamespace(server_port=12345, result=None, server_close=Mock())
            http.handle_request = Mock(side_effect=lambda: setattr(http, "result", {"ok": True}))
            process.poll.return_value = None
            worker_http = SimpleNamespace(server_address=("127.0.0.1", 12345),
                finished=SimpleNamespace(wait=Mock(return_value=True)), result={"ok": True},
                unexpected=[], serve_forever=Mock(), shutdown=Mock(), server_close=Mock())
            with patch.dict(os.environ, {"TMPDIR": "/tmp/" + "x" * 200}), \
                    patch("subprocess.run", return_value=SimpleNamespace(stdout="Chromium")), \
                    patch("subprocess.Popen", side_effect=launch), \
                    patch.object(package_browser, "stop"), patch.object(feature_sdk_browser, "stop"), \
                    patch.object(package_browser, "HTTPServer", return_value=http), \
                    patch.object(feature_sdk_browser, "ThreadingHTTPServer", return_value=worker_http), \
                    patch.object(feature_sdk_browser.threading, "Event", return_value=SimpleNamespace(wait=Mock(return_value=True))), \
                    patch.object(feature_sdk_browser.threading, "Thread"):
                package_browser.run_browser(package, work, root, identity, "chromium")
                feature_sdk_browser.run_browser(root, package, work, "chromium", *([core] * 10))
            self.assertEqual(len(seen), 2)
            self.assertTrue(all(not path.exists() for path in seen))


if __name__ == "__main__":
    unittest.main()
