import { expect, test } from "bun:test";
import { prepareModuleManifests } from "../bindings/typescript/src/module-manifest.ts";
import { compileNumericModules, prepareNumericProfile } from "../bindings/typescript/src/numeric-environment.ts";
import { inspectFeatureModuleGraph } from "../target/validator/feature-validator.js";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

test("shared label graphs validate without executing a host or guest", async () => {
  const path = Bun.env.LVW_TEST_LABEL_GRAPH;
  if (!path) throw new Error("LVW_TEST_LABEL_GRAPH is required");
  const cases = await Bun.file(path).json() as any[];
  expect(cases.length).toBeGreaterThan(15);
  for (const item of cases) {
    const input = { ...item.input, modules: item.input.modules.map((module: any) => ({ manifest: module.manifest,
      bytes: new Uint8Array(Buffer.from(module.hex, "hex")) })) };
    let factories = 0;
    const options = { profile: "lvgl-label-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: { name: "lvw", version: 1 }, abiVersion: 1 },
      label: item.label, modules: item.profile.modules, hosts: item.profile.hosts.map((host: any) => ({ ...host,
        create: () => { factories++; throw new Error("preflight must not create a host"); } })),
      ...(item.wasi ? { wasi: { id: "host.wasi", interface: { name: "wasi", version: 1 },
        allowed: ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"],
        outputFds: [], maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096,
        clock: { realtimeNs: 0n, monotonicNs: 0n }, onWrite: () => { throw new Error("preflight must not write"); } } } : {}),
      ...item.profile.limits, allowedFeatures: item.allowedFeatures, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000 };
    const check = () => { const prepared = prepareModuleManifests(input); prepareNumericProfile(prepared, options); compileNumericModules(prepared); };
    if (item.pass || item.error === "feature") expect(check, item.name).not.toThrow();
    else {
      const errors: Record<string, string> = { "core-no-memory": "label profile requires owned exported memory",
        "app-no-memory": "label profile requires owned exported memory", alias: "LVGL label import is not authorized",
        signature: "LVGL label host contract differs", "core-steal": "LVGL label host is reserved for its app",
        "missing-create": "missing lv_label_create", "imported-alloc": "lvw_alloc must be an owned function",
        "bad-display": "invalid lvw_display_create signature", "missing-dependency": "label app must depend on its LVGL core",
        identity: "numeric module is not authorized", "id-conflict": "LVGL label provider identity conflicts",
        "zero-width": "invalid LVGL label limits", "oversized-frame": "invalid LVGL label limits",
        "zero-labels": "invalid LVGL label limits", "zero-text": "invalid LVGL label limits", "too-many-labels": "invalid numeric resource limit",
        "text-too-long": "invalid numeric resource limit", "pointer-export": "unsupported LVGL scalar export" };
      expect(check, item.name).toThrow(errors[item.name]!);
    }
    expect(factories, item.name).toBe(0);
    if (item.name === "real") {
      const report = await inspectFeatureModuleGraph(input, options);
      expect(report.order).toEqual(["lvcore", "app"]);
      for (const module of report.modules) {
        expect(module.checks.engine).toBe("passed");
        expect(module.checks.hostImplementation).toBe("not-run");
        expect(module.checks.lifecycle).toBe("not-run");
        expect(module.checks.runtime).toBe("not-run");
      }
    }
    if (item.error === "feature") {
      const error = await inspectFeatureModuleGraph(input, options).then(() => null, (failure) => failure);
      expect(String(error)).toContain('"app": feature inspection failed');
      expect(String(error)).toContain("invalid under the declared feature policy");
    }
  }
}, 300_000);

test("label graph generation publishes only new outputs and survives interruption", async () => {
  const directory = await mkdtemp("target/validator/.numeric-label-check-");
  try {
    const script = "tests/fixtures/numeric-label/generate.ts";
    const run = (output: string, extra: string[] = []) => Bun.spawnSync([process.execPath, script, "--real-only", "--output", output, ...extra]);
    const output = join(directory, "graph.json");
    const good = run(output);
    expect(good.exitCode, good.stderr.toString()).toBe(0);
    const original = await Bun.file(output).bytes();
    const again = run(output);
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr.toString()).toContain("output already exists");
    expect(await Bun.file(output).bytes()).toEqual(original);

    const proof = await Bun.file("target/wasm/api-verification-bounded.json").json();
    proof.wasm_sha256 = "0".repeat(64);
    const badProof = join(directory, "bad-proof.json"), rejected = join(directory, "rejected.json");
    await Bun.write(badProof, JSON.stringify(proof));
    const bad = run(rejected, ["--proof", badProof]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr.toString()).toContain("bounded core proof does not match");
    expect(await Bun.file(rejected).exists()).toBe(false);
    expect(await Bun.file(output).bytes()).toEqual(original);

    const target = join(directory, "target.txt"), linked = join(directory, "linked.json");
    await Bun.write(target, "symlink target");
    await symlink(resolve(target), linked);
    const refused = run(linked);
    expect(refused.exitCode).not.toBe(0);
    expect(await Bun.file(target).text()).toBe("symlink target");
    const dangling = join(directory, "dangling.json");
    await symlink(join(directory, "missing"), dangling);
    expect(run(dangling).exitCode).not.toBe(0);

    const simultaneous = join(directory, "simultaneous.json");
    const spawn = (path: string, detached = false) => Bun.spawn([process.execPath, script, "--real-only", "--output", path],
      { stdout: "pipe", stderr: "pipe", detached });
    const jobs = [spawn(simultaneous), spawn(simultaneous)];
    const results = await Promise.all(jobs.map(async (job) => ({ status: await job.exited, error: await new Response(job.stderr).text() })));
    expect(results.filter(({ status }) => status === 0)).toHaveLength(1);
    const failure = results.find(({ status }) => status !== 0)!;
    expect(failure.error.includes("output already exists") || failure.error.includes("EEXIST")).toBe(true);
    expect((await Bun.file(simultaneous).json())[0].name).toBe("real");

    const waitForStaging = async (path: string) => {
      const deadline = Date.now() + 10_000;
      while (!(await readdir(path)).some((name) => name.startsWith(".numeric-label-")) && Date.now() < deadline) await Bun.sleep(5);
      expect((await readdir(path)).some((name) => name.startsWith(".numeric-label-"))).toBe(true);
    };
    const raceDir = join(directory, "race"), raceOutput = join(raceDir, "graph.json");
    await mkdir(raceDir);
    const racer = spawn(raceOutput, true);
    try {
      await waitForStaging(raceDir);
      process.kill(-racer.pid, "SIGSTOP");
      expect(await Bun.file(raceOutput).exists()).toBe(false);
      await Bun.write(raceOutput, "external file");
      await Bun.write(`${raceOutput}.owner.json`, "external marker");
      process.kill(-racer.pid, "SIGCONT");
      const [raceStatus] = await Promise.all([racer.exited, new Response(racer.stderr).text()]);
      expect(raceStatus).not.toBe(0);
      expect(await Bun.file(raceOutput).text()).toBe("external file");
      expect(await Bun.file(`${raceOutput}.owner.json`).text()).toBe("external marker");
    } finally { try { process.kill(-racer.pid, "SIGKILL"); } catch {} }

    const killDir = join(directory, "killed"), interrupted = join(killDir, "graph.json");
    await mkdir(killDir);
    const child = spawn(interrupted, true);
    try {
      await waitForStaging(killDir);
      process.kill(-child.pid, "SIGKILL");
      const [status] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(status).not.toBe(0);
      expect(await Bun.file(interrupted).exists()).toBe(false);
      const resumed = run(interrupted);
      expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
      expect((await Bun.file(interrupted).json())[0].name).toBe("real");
    } finally { try { process.kill(-child.pid, "SIGKILL"); } catch {} }

    const synthetic = join(directory, "synthetic"), extra = join(directory, "extra"), alias = join(directory, "alias");
    await mkdir(synthetic); await mkdir(extra); await symlink(resolve(synthetic), alias);
    await Bun.write(join(synthetic, "source.wasm"), "sentinel"); await Bun.write(join(extra, "source.wasm"), "sentinel");
    for (const path of [join(synthetic, "source.wasm"), join(extra, "source.wasm"), join(alias, "source.wasm")]) {
      const result = Bun.spawnSync([process.execPath, script, "--synthetic", synthetic, "--extra", extra, "--output", path]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("label graph output overlaps a fixture directory");
      expect(await Bun.file(path).text()).toBe("sentinel");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
