import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const output = await mkdtemp(join(tmpdir(), "lvw host sdk "));
await mkdir("target/validator", { recursive: true });
const scratch = await mkdtemp(join(process.cwd(), "target/validator/lvw-sdk-test-"));
let sdkReady = false;
let safeToClean = true;

async function removeOwnedDirectory(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeOwnedDirectory(join(path, entry.name));
  }
  await rm(path, { recursive: true, force: true });
}

afterAll(async () => {
  if (!safeToClean) throw new Error(`SDK subprocess group is still active; retained ${output} and ${scratch}`);
  const results = await Promise.allSettled([removeOwnedDirectory(output), removeOwnedDirectory(scratch)]);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "SDK test directory cleanup failed");
}, 30_000);

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function drainGroup(pid: number): Promise<void> {
  safeToClean = false;
  if (groupExists(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (groupExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`SDK subprocess group ${pid} did not exit`);
    }
    await Bun.sleep(50);
  }
  safeToClean = true;
}

async function runConsumer(args: string[], timeoutMs: number) {
  const child = spawn("python3", ["-B", "tests/host-sdk-consumer.py", ...args], {
    detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LVW_TEST_SDK_SCRATCH: scratch },
  });
  if (child.pid !== undefined) safeToClean = false;
  let stdout = "", stderr = "", timedOut = false, killError: unknown;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") { killError = error; child.kill("SIGKILL"); }
      }
    }
  }, timeoutMs);
  let status: number | null;
  try {
    status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timer);
    if (child.pid !== undefined) await drainGroup(child.pid);
  }
  expect(killError, stdout + stderr).toBeUndefined();
  expect(timedOut, stdout + stderr).toBe(false);
  expect(status, stdout + stderr).toBe(0);
}

test("exported host packages resolve types and bindings outside the checkout", async () => {
  const build = Bun.env.LVW_TEST_BUILD;
  await runConsumer([output, ...(build ? [build] : [])],
    Bun.env.LVW_TEST_CALLBACKS || Bun.env.LVW_TEST_SOFTWARE ? 880_000 : 580_000);
  const packages = await Bun.file(join(output, "report.json")).json();
  for (const [index, entry] of packages.entries()) {
    const { exercise } = await import(join(entry.consumer, "target/consumer.js"));
    const bytes = await Bun.file(join(entry.package, "runtime/liblvgl.wasm")).arrayBuffer();
    const other = await Bun.file(join(packages[1 - index].package, "runtime/liblvgl.wasm")).arrayBuffer();
    const result = await exercise(bytes, other, await Bun.file("examples/browser/red.bmp").bytes());
    expect(result.identity.sdk.status).toBe("matched");
    expect(result.identity.coreSha256).toBe(entry.identity.wasm_sha256);
    expect(result.wide).toBe(18014398509494329n);
    expect(result.roundtrip).toBe(0x123456);
    expect(result.pixel).toEqual([0x12, 0x34, 0x56]);
    expect(result.clicks).toBe(1);
    expect(result.remaining).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.closed).toBe(true);
    expect(result.mismatch).toBe(true);
    expect(result.resourcePixel).toEqual([255, 0, 0]);
    expect(result.timerRejected).toBe(!result.hasTimer);
    expect(result.aliveAfterTimer).toBe(true);
  }
  sdkReady = true;
}, Bun.env.LVW_TEST_CALLBACKS || Bun.env.LVW_TEST_SOFTWARE ? 900_000 : 600_000);

(Bun.env.LVW_TEST_BUILD ? test.skip : test)("relocated host packages run the isolated C library chain", async () => {
  if (!sdkReady) throw new Error("host SDK setup did not complete");
  await runConsumer(["--chain-only", output], 280_000);
}, 300_000);

(Bun.env.LVW_TEST_BUILD ? test.skip : test)("relocated host packages check the label library consumer", async () => {
  if (!sdkReady) throw new Error("host SDK setup did not complete");
  await runConsumer(["--label-consumer-only", output], 280_000);
}, 300_000);

(Bun.env.LVW_TEST_BUILD ? test.skip : test)("relocated host packages run the event library consumer", async () => {
  if (!sdkReady) throw new Error("host SDK setup did not complete");
  await runConsumer(["--event-consumer-only", output], 280_000);
}, 300_000);
