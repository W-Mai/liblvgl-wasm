import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("timer adaptation rejects unknown source bytes and removes stale generated code", async () => {
  const root = await mkdtemp(join(tmpdir(), "lvw timer source "));
  try {
    await mkdir(join(root, "src/misc"), { recursive: true });
    await mkdir(join(root, "lvgl-adapted"));
    const source = join(root, "src/misc/lv_timer.c");
    const adapted = join(root, "lvgl-adapted/lv_timer.c");
    await Bun.write(source, "/* unverified timer implementation */\n");
    await Bun.write(adapted, "/* stale adapted timer */\n");
    await Bun.write(join(root, "check.cmake"),
      `cmake_minimum_required(VERSION 3.25)\ninclude("${resolve("cmake/timer.cmake")}")\n`);
    const child = Bun.spawn(["cmake", `-Dlvgl_SOURCE_DIR=${root}`, "-P", "check.cmake"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(status, stdout + stderr).not.toBe(0);
    expect(stderr).toContain("Unsupported LVGL timer source");
    expect(await Bun.file(adapted).exists()).toBe(false);
    expect(await Bun.file(source).text()).toBe("/* unverified timer implementation */\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
