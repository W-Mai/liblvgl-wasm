"""Exercise the Studio module runner with real C modules in an opaque browser worker."""

import argparse
import hashlib
from http.server import HTTPServer
import json
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time

from package_browser import Handler, browser_directory, stop

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "target/studio/modules"

PAGE = r'''<!doctype html><meta charset="utf-8"><script type="module">
import { ModuleController, loadModuleProject } from "/target/studio/modules/controller.js";
const check = (value, message) => { if (!value) throw new Error(message); };
const outputs = [[], []], errors = [];
addEventListener("error", event => errors.push(String(event.message)));
addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const controllers = outputs.map(items => new ModuleController(message => items.push(message)));
const wait = async predicate => {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Browser message timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const frame = index => outputs[index].filter(item => item.type === "frame").at(-1);
const equal = (a, b) => a.every((value, index) => value === b[index]);
const rejects = async operation => {
  try { await operation(); } catch { return; }
  throw new Error("Expected module rejection");
};
try {
  const { project, input } = await loadModuleProject();
  await controllers[0].start(input, 120, 48, "inspect");
  const inspected = outputs[0].find(item => item.type === "module-inspected");
  check(inspected?.executable && inspected.report.order.join() === "lvcore,middle,app", "Module preflight differs");
  check(inspected.report.modules.every(item => item.checks.runtime === "not-run"), "Preflight claimed runtime verification");
  check(!outputs[0].some(item => item.type === "frame" || item.type === "module-ready"), "Preflight ran an environment");
  controllers[0].stop();
  outputs[0].length = 0;
  await Promise.all(controllers.map(controller => controller.start(input, 120, 48)));
  await wait(() => frame(0) && frame(1));
  const initial = new Uint8Array(frame(0).pixels).slice(), other = new Uint8Array(frame(1).pixels).slice();
  check(initial.length === 120 * 48 * 4 && equal(initial, other), "Initial native frames differ");
  const iframe = document.querySelector("iframe");
  check(iframe.sandbox.value === "allow-scripts" && iframe.contentDocument === null
    && iframe.srcdoc.includes("connect-src 'none'"), "Module runner lost its opaque sandbox");
  let result = await controllers[0].action("event");
  await wait(() => outputs[0].filter(item => item.type === "frame").length >= 2);
  check(result.count === 2 && result.nested.join() === "11,12,22,21", "C callback nesting differs");
  check(!equal(initial, new Uint8Array(frame(0).pixels)), "C callback did not change native pixels");
  check(equal(other, new Uint8Array(frame(1).pixels)), "The second environment changed");
  await controllers[0].action("unsubscribe");
  check((await controllers[0].action("event")).count === 2, "C callback remained subscribed");
  await controllers[0].action("subscribe");
  check((await controllers[0].action("event")).count === 3, "C callback was not restored");
  check((await controllers[1].action("event")).count === 2, "Second environment lost its independent state");
  result = await controllers[0].close();
  check(result.state === "closed" && result.trace.map(item => item.code).join() === "10,20,21,11", "Reverse C close differs");
  check((await controllers[1].action("event")).count === 3, "Closing one environment closed another");
  await controllers[1].close();
  check(document.querySelectorAll("iframe").length === 0, "Closed runner retained its iframe");

  const changed = structuredClone(input), app = changed.modules.find(item => item.manifest.id === "app");
  const bytes = new Uint8Array(app.bytes.length + 4);
  bytes.set(app.bytes); bytes.set([0, 2, 1, 120], app.bytes.length);
  check(WebAssembly.validate(bytes), "Identity control is not a valid module");
  app.bytes = bytes;
  app.manifest.artifact.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    value => value.toString(16).padStart(2, "0")).join("");
  outputs[0].length = 0;
  await controllers[0].start(changed, 120, 48, "inspect");
  check(outputs[0].find(item => item.type === "module-inspected")?.executable === false, "Custom bytes received built-in execution authorization");
  await rejects(() => controllers[0].start(changed, 120, 48));
  check(!outputs[0].some(item => item.type === "module-ready" || item.type === "frame"), "Rejected modules ran");
  controllers[0].stop();

  outputs[0].length = 0;
  await controllers[0].start(input, 160, 80);
  await wait(() => frame(0));
  check(frame(0).width === 160 && frame(0).height === 80, "Resolution restart did not recreate the native display");
  check((await controllers[0].action("event")).count === 2, "Restart retained the old C state");
  const restarts = await Promise.allSettled([
    controllers[0].start(input, 200, 100), controllers[0].start(input, 240, 120)
  ]);
  check(restarts[0].status === "rejected" && restarts[0].reason.name === "AbortError"
    && restarts[1].status === "fulfilled", "Overlapping restarts did not preserve the latest project");
  await wait(() => frame(0).width === 240 && frame(0).height === 120);
  check((await controllers[0].action("event")).count === 2, "The latest restart did not create a fresh environment");
  await controllers[0].close();
  check(errors.length === 0, errors.join("\n"));
  await fetch(ENDPOINT, { method: "POST", body: JSON.stringify({
    ok: true, preflight: true, opaqueSandbox: true, realCEvents: true, frameChanged: true,
    independentEnvironments: true, subscriptions: true, reverseClose: true,
    customExecutionBlocked: true, resolutionRestart: true, latestRestartWins: true, errors, browser: navigator.userAgent,
    modules: project.modules.map(item => ({ id: item.manifest.id, sha256: item.manifest.artifact.sha256 }))
  }) });
} catch (error) {
  controllers.forEach(controller => controller.stop());
  await fetch(ENDPOINT, { method: "POST", body: JSON.stringify({ ok: false, error: String(error.stack || error), errors }) });
}
</script>'''


def check(chromium):
    metadata = json.loads((ASSETS / "build.json").read_bytes())
    if metadata.get("kind") != "studio-module-build":
        raise ValueError("Studio module build metadata is missing")
    for name, sha in metadata["files"].items():
        path = ASSETS / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != sha:
            raise ValueError("Studio module build inventory differs: " + name)
    with tempfile.TemporaryDirectory(prefix="studio-module-browser-", dir=ROOT / "target") as work, browser_directory() as profile:
        work = Path(work)
        endpoint = "/result/" + secrets.token_urlsafe(24)
        html = work / "index.html"
        html.write_text(PAGE.replace("ENDPOINT", json.dumps(endpoint)))
        server = HTTPServer(("127.0.0.1", 0), Handler)
        server.timeout = 0.2
        server.result = None
        server.endpoint = endpoint
        server.routes = {"/studio/": (html, "text/html; charset=utf-8")}
        for name in metadata["runtime_files"]:
            server.routes["/target/studio/modules/" + name] = (ASSETS / name, mimetypes.guess_type(name)[0] or "application/octet-stream")
        environment = dict(os.environ, TMPDIR=profile)
        for key in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"):
            environment.pop(key, None)
        flags = [chromium, "--headless", "--disable-gpu", "--disable-dev-shm-usage",
                 "--disable-background-networking", "--no-first-run", "--user-data-dir=" + profile + "/profile"]
        if environment.get("LVW_TEST_BROWSER_NO_SANDBOX") == "1":
            flags.append("--no-sandbox")
        process = None
        try:
            with (work / "browser.log").open("w") as log:
                process = subprocess.Popen([*flags, "http://127.0.0.1:" + str(server.server_port) + "/studio/"],
                                           env=environment, stdout=log, stderr=log, start_new_session=True)
                deadline = time.monotonic() + 120
                while server.result is None:
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise TimeoutError("Studio module browser did not report")
                    server.handle_request()
            if not server.result.get("ok"):
                raise RuntimeError(json.dumps(server.result))
            result = {"build_sha256": hashlib.sha256((ASSETS / "build.json").read_bytes()).hexdigest(), **server.result}
            (ROOT / "target/studio/modules-browser.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(result))
        finally:
            if process is not None:
                stop(process)
            server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chromium", default=os.environ.get("LVW_TEST_BROWSER") or shutil.which("chromium")
                        or shutil.which("google-chrome-stable")
                        or ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                            if Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").is_file() else None))
    arguments = parser.parse_args()
    if not arguments.chromium:
        parser.error("set LVW_TEST_BROWSER or pass --chromium")
    check(arguments.chromium)
