/** Exercise the actual Studio file input, toolbar, worker and inspector together. */
export async function checkStudioUpload() {
  const page = document.createElement("iframe");
  page.src = "/studio/index.html";
  document.body.append(page);
  const get = id => page.contentDocument?.getElementById(id);
  const visible = id => Boolean(get(id)?.getClientRects().length);
  async function wait(check, message) {
    const deadline = performance.now() + 20000;
    while (!check()) {
      if (performance.now() > deadline) throw new Error(message + ": " + get("module-project-status")?.textContent);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async function file(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Missing upload fixture: " + path);
    return new File([await response.blob()], path.split("/").at(-1));
  }
  async function upload(directory, alter) {
    const manifest = JSON.parse(await (await file(directory + "/project.json")).text());
    if (alter) alter(manifest);
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(manifest)], "project.json"));
    for (const { manifest: module } of manifest.modules) dt.items.add(await file(directory + "/" + module.artifact.path));
    const input = get("module-files");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  try {
    await wait(() => get("module-event") && !get("module-event").disabled, "Built-in project did not start");
    for (const [directory, profile, display, value, result] of [
      ["/custom", "lvgl-event-v1", true, -37, 63], ["/headless", "numeric-v1", false, 12, 112]
    ]) {
      await upload(directory);
      await wait(() => get("module-upload").getAttribute("aria-pressed") === "true"
        && get("module-project-status").textContent.includes("project.json")
        && get("module-project-status").textContent.includes(profile) && !get("run-button").disabled,
        "Upload did not pass preflight");
      if (visible("module-event")) throw new Error("Sample controls remained visible after upload");
      if (!visible("module-call")) throw new Error("Uploaded project's app_run form is missing");
      if (!get("module-invoke").disabled) throw new Error("Preflight enabled app_run before start");
      if (visible("screen")) throw new Error("Sample frame remained visible after upload");
      get("run-button").click();
      await wait(() => !get("module-invoke").disabled && visible("screen") === display, "Incorrect runtime controls");
      if (get("module-result").textContent !== "—" || !get("module-trace").textContent.includes("meter · 30")) {
        throw new Error("Startup result or trace does not belong to this project");
      }
      get("module-argument").value = String(value);
      get("module-invoke").click();
      await wait(() => get("module-result").textContent === String(result), "Incorrect app_run result");
      get("stop-button").click();
      await wait(() => get("module-trace").textContent.includes("meter · 31") && get("module-invoke").disabled,
        "Module did not close");
    }
    await upload("/headless", project => {
      const host = project.hosts.find(host => host.interface.name === "trace");
      host.interface.name = "unavailable";
      for (const { manifest } of project.modules) {
        for (const edge of manifest.requires) if (edge.provider === host.id) edge.interface = "unavailable";
      }
    });
    await wait(() => get("module-project-status").textContent.includes("unavailable"), "Missing interface diagnostic");
    if (!get("run-button").disabled || !get("module-invoke").disabled) throw new Error("Unsupported project can run");
    get("module-default").click();
    await wait(() => visible("module-event") && !get("module-event").disabled, "Cannot return to the C sample");
    return true;
  } finally {
    page.remove();
  }
}
