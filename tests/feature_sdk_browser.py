"""Exercise the relocated feature SDK in an opaque browser worker."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading

from package_browser import browser_directory, stop


def page(endpoint):
    frame = '''<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src blob:"><script>
onmessage = ({data}) => {
  const url = URL.createObjectURL(new Blob([data.code], {type:'text/javascript'}));
  const worker = new Worker(url);
  worker.onmessage = event => { worker.terminate(); URL.revokeObjectURL(url); parent.postMessage(event.data, '*'); };
  worker.onerror = event => { worker.terminate(); URL.revokeObjectURL(url); parent.postMessage({error:event.message}, '*'); };
  worker.postMessage({core:data.core, wasi:data.wasi, lvProvider:data.lvProvider, lvApp:data.lvApp, standaloneCore:data.standaloneCore, standaloneApp:data.standaloneApp, labelApp:data.labelApp, eventApp:data.eventApp, chainGraph:data.chainGraph, labelLibGraph:data.labelLibGraph}, [data.core, data.wasi, data.lvProvider, data.lvApp, data.standaloneCore, data.standaloneApp, data.labelApp, data.eventApp, data.chainGraph, data.labelLibGraph]);
};
</script>'''
    return '''<!doctype html><iframe sandbox="allow-scripts"></iframe><script>
const frame = document.querySelector('iframe');
frame.srcdoc = %s;
window.onmessage = event => { if (event.source === frame.contentWindow) fetch(%s, {method:'POST', body:JSON.stringify(event.data)}); };
frame.onload = async () => {
  const [code, core, wasi, lvProvider, lvApp, standaloneCore, standaloneApp, labelApp, eventApp, chainGraph, labelLibGraph] = await Promise.all([fetch('/consumer.js').then(r => r.text()), fetch('/core').then(r => r.arrayBuffer()), fetch('/wasi').then(r => r.arrayBuffer()), fetch('/lv-provider').then(r => r.arrayBuffer()), fetch('/lv-app').then(r => r.arrayBuffer()), fetch('/standalone-core').then(r => r.arrayBuffer()), fetch('/standalone-app').then(r => r.arrayBuffer()), fetch('/label-app').then(r => r.arrayBuffer()), fetch('/event-app').then(r => r.arrayBuffer()), fetch('/chain-graph').then(r => r.arrayBuffer()), fetch('/label-lib-graph').then(r => r.arrayBuffer())]);
  frame.contentWindow.postMessage({code, core, wasi, lvProvider, lvApp, standaloneCore, standaloneApp, labelApp, eventApp, chainGraph, labelLibGraph}, '*', [core, wasi, lvProvider, lvApp, standaloneCore, standaloneApp, labelApp, eventApp, chainGraph, labelLibGraph]);
};
</script>''' % (json.dumps(frame).replace("</", "<\\/"), json.dumps(endpoint))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/":
            data, content = page(self.server.endpoint).encode(), "text/html; charset=utf-8"
        elif self.path in self.server.files:
            path, content = self.server.files[self.path]
            data = path.read_bytes()
        else:
            self.server.unexpected.append(self.path)
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != self.server.endpoint:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "-1"))
        if not 0 < length <= 64 * 1024:
            self.send_error(400)
            return
        self.server.result = json.loads(self.rfile.read(length))
        self.send_response(204)
        self.end_headers()
        self.server.finished.set()

    def log_message(self, *args):
        pass


def run_browser(project, sdk, work, chromium, wasi, lv_provider, lv_app, standalone_core, standalone_app, label_app, event_app, chain_graph, label_lib_graph):
    with browser_directory() as directory:
        return _run_browser(project, sdk, work, chromium, wasi, lv_provider, lv_app, standalone_core, standalone_app, label_app, event_app, chain_graph, label_lib_graph, directory)


def _run_browser(project, sdk, work, chromium, wasi, lv_provider, lv_app, standalone_core, standalone_app, label_app, event_app, chain_graph, label_lib_graph, directory):
    consumer = project / "target/browser-worker.js"
    subprocess.run(["bun", "build", "browser-worker.ts", "--target", "browser", "--format", "iife",
                    "--outfile", consumer], cwd=project, check=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.endpoint = "/result/" + secrets.token_urlsafe(24)
    server.files = {"/consumer.js": (consumer, "text/javascript; charset=utf-8"),
                    "/core": (sdk / "runtime/liblvgl.wasm", "application/wasm"),
                    "/wasi": (wasi, "application/wasm"),
                    "/lv-provider": (lv_provider, "application/wasm"),
                    "/lv-app": (lv_app, "application/wasm"),
                    "/standalone-core": (standalone_core, "application/wasm"),
                    "/standalone-app": (standalone_app, "application/wasm"),
                    "/label-app": (label_app, "application/wasm"),
                    "/event-app": (event_app, "application/wasm"),
                    "/chain-graph": (chain_graph, "application/json"),
                    "/label-lib-graph": (label_lib_graph, "application/json")}
    server.finished = threading.Event()
    server.unexpected = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env["TMPDIR"] = directory
    for key in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"):
        env.pop(key, None)
    flags = [chromium, "--headless", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
             "--disable-extensions", "--no-first-run", "--user-data-dir=" + directory + "/profile"]
    if env.get("LVW_TEST_BROWSER_NO_SANDBOX") == "1":
        flags.append("--no-sandbox")
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    with (work / "browser.log").open("w") as log:
        process = subprocess.Popen([*flags, url], cwd=work, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
        try:
            if not server.finished.wait(120):
                raise TimeoutError("feature SDK browser worker did not report")
            if server.unexpected:
                raise ValueError(f"unexpected browser requests: {server.unexpected}")
            return server.result
        finally:
            stop(process)
            server.shutdown()
            server.server_close()
