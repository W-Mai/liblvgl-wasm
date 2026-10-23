import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("exported host packages resolve types and bindings outside the checkout", async () => {
  const output = await mkdtemp(join(tmpdir(), "lvw host sdk "));
  try {
    const build = Bun.env.LVW_TEST_BUILD;
    const child = Bun.spawn(["python3", "-B", "tests/host-sdk-consumer.py", output, ...(build ? [build] : [])], {
      stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(status, stdout + stderr).toBe(0);
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
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 180_000);
