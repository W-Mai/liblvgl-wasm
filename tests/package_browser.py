"""Run an exported TypeScript SDK in an installed headless Chromium browser."""

import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
from urllib.parse import quote, urlsplit


def page(config):
    imports = {"imports": {"liblvgl-wasm": config["sdk"]}}
    return f'''<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{json.dumps(imports)}</script></head><body>
<script type="module">
const config = {json.dumps(config)};
const errors = [];
addEventListener("error", event => errors.push(String(event.message)));
addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
async function load(url) {{
  const response = await fetch(url, {{ cache: "no-store" }});
  if (!response.ok) throw new Error(`HTTP ${{response.status}}: ${{url}}`);
  return new Uint8Array(await response.arrayBuffer());
}}
async function report(value) {{
  const response = await fetch(config.result, {{ method: "POST",
    headers: {{ "content-type": "application/json" }},
    body: JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v) }});
  if (!response.ok) throw new Error(`result HTTP ${{response.status}}`);
}}
try {{
  const {{ exercise }} = await import("/browser-consumer.js");
  const [core, bitmap] = await Promise.all([load(config.core), load(config.bitmap)]);
  const other = new Uint8Array(core.length + 4);
  other.set(core);
  other.set([0, 2, 1, 120], core.length);
  if (!WebAssembly.validate(other)) throw new Error("identity control module is invalid");
  const result = await exercise(core.buffer, other.buffer, bitmap);
  const checks = {{
    identity: result.identity.sdk.status === "matched" &&
      result.identity.coreSha256 === config.coreSha256 &&
      result.identity.sdk.coreSha256 === config.coreSha256 &&
      result.identity.sdk.apiSha256 === config.apiSha256,
    raw: result.wide === 18014398509494329n && result.roundtrip === 0x123456,
    frame: result.pixel.join(",") === "18,52,86" && result.changed,
    input: result.clicks === 1,
    resource: result.resourcePixel.join(",") === "255,0,0",
    timer: result.timerRejected === !result.hasTimer && result.aliveAfterTimer,
    lifetime: result.remaining === 0 && result.closed,
    mismatch: result.mismatch,
    browserErrors: errors.length === 0,
  }};
  await report({{ ok: Object.values(checks).every(Boolean), checks, result,
    browser: navigator.userAgent, errors }});
}} catch (error) {{
  await report({{ ok: false, error: String(error?.stack || error), errors,
    browser: navigator.userAgent }});
}}
</script></body></html>'''


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def do_GET(self):
        entry = self.server.routes.get(urlsplit(self.path).path)
        if entry is None:
            self.send_error(404)
            return
        file, content_type = entry
        try:
            data = file.read_bytes()
        except OSError:
            self.send_error(500)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if urlsplit(self.path).path != self.server.endpoint:
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "-1"))
            if not 0 < size <= 2 * 1024 * 1024:
                raise ValueError("invalid report size")
            result = json.loads(self.rfile.read(size))
            if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                raise ValueError("invalid report")
        except (ValueError, json.JSONDecodeError):
            self.send_error(400)
            return
        self.server.result = result
        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        pass


def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_browser(package, work, project, identity, chromium):
    core = package / "host-sdk/runtime/liblvgl.wasm"
    api = package / "host-sdk/metadata/api.json"
    if (hashlib.sha256(core.read_bytes()).hexdigest() != identity["wasm_sha256"] or
            hashlib.sha256(api.read_bytes()).hexdigest() != identity["api_sha256"]):
        raise ValueError("package identity does not match the core and API bytes")
    cache, config, data, runtime = (work / name for name in ("cache", "config", "data", "runtime"))
    for directory in (cache, config, data, runtime):
        directory.mkdir(mode=0o700)
    env = {**os.environ, "TMPDIR": str(work), "CHROME_CONFIG_HOME": str(config),
           "XDG_CACHE_HOME": str(cache), "XDG_CONFIG_HOME": str(config),
           "XDG_DATA_HOME": str(data), "XDG_RUNTIME_DIR": str(runtime),
           "BUN_INSTALL_CACHE_DIR": str(work / "bun-cache")}
    for variable in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"):
        env.pop(variable, None)
    version = subprocess.run([chromium, "--version"], capture_output=True, text=True,
                             env=env, timeout=15, check=True).stdout.strip()
    if not version:
        raise ValueError("browser version output is empty")
    subprocess.run(["bun", "build", "consumer.ts", "--target", "browser", "--external",
                    "liblvgl-wasm", "--outfile", "target/browser-consumer.js"],
                   cwd=project, env=env, stdout=sys.stderr, timeout=120, check=True)
    prefix = "/" + quote(package.name)
    sdk_url = prefix + "/host-sdk/typescript/index.js"
    core_url = prefix + "/host-sdk/runtime/liblvgl.wasm"
    bitmap_url = prefix + "/source/examples/browser/red.bmp"
    endpoint = "/result/" + secrets.token_urlsafe(24)
    config = {"sdk": sdk_url, "core": core_url, "bitmap": bitmap_url, "result": endpoint,
              "coreSha256": identity["wasm_sha256"], "apiSha256": identity["api_sha256"]}
    html = work / "browser.html"
    html.write_text(page(config))
    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 0.2
    server.endpoint = endpoint
    server.result = None
    server.routes = {
        "/browser.html": (html, "text/html; charset=utf-8"),
        "/browser-consumer.js": (project / "target/browser-consumer.js", "text/javascript; charset=utf-8"),
        sdk_url: (package / "host-sdk/typescript/index.js", "text/javascript; charset=utf-8"),
        core_url: (core, "application/wasm"),
        bitmap_url: (package / "source/examples/browser/red.bmp", "image/bmp"),
    }
    process = None
    log = work / "browser.log"
    try:
        with log.open("w") as output:
            process = subprocess.Popen([chromium, "--headless", "--disable-gpu",
                "--disable-background-networking", "--disable-default-apps", "--disable-sync",
                "--disable-extensions", "--no-first-run", "--no-default-browser-check",
                "--password-store=basic", f"--user-data-dir={work / 'profile'}",
                f"http://127.0.0.1:{server.server_port}/browser.html"],
                cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=output,
                stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 120
            while server.result is None:
                if process.poll() is not None:
                    raise RuntimeError(f"browser exited before reporting: {process.returncode}")
                if time.monotonic() >= deadline:
                    raise TimeoutError("browser did not report within 120 seconds")
                server.handle_request()
        if not server.result["ok"]:
            raise RuntimeError(f"browser acceptance failed: {json.dumps(server.result)}")
        return {"version": version, **server.result}
    except Exception:
        if process is not None:
            stop(process)
            process = None
        if log.exists():
            with log.open("rb") as output:
                output.seek(max(0, log.stat().st_size - 16000))
                print(output.read().decode(errors="replace"), file=sys.stderr)
        raise
    finally:
        if process is not None:
            stop(process)
        server.server_close()
