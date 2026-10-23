import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.each([
  ["timer", "src/misc", "lv_timer.c"], ["animation", "src/misc", "lv_anim.c"],
  ["observer", "src/core", "lv_observer.c"], ["observer", "src/others/observer", "lv_observer.c"],
])(
  "%s adaptation in %s rejects unknown source bytes and removes stale generated code",
  async (adapter, directory, filename) => {
    const root = await mkdtemp(join(tmpdir(), `lvw ${adapter} source `));
    try {
      await mkdir(join(root, directory), { recursive: true });
      await mkdir(join(root, "lvgl-adapted"));
      const source = join(root, directory, filename);
      const adapted = join(root, "lvgl-adapted", filename);
      await Bun.write(source, "/* unverified implementation */\n");
      await Bun.write(adapted, "/* stale adapted code */\n");
      await Bun.write(join(root, "check.cmake"),
        `cmake_minimum_required(VERSION 3.25)\ninclude("${resolve(`cmake/${adapter}.cmake`)}")\n`);
      const child = Bun.spawn(["cmake", `-Dlvgl_SOURCE_DIR=${root}`, "-P", "check.cmake"], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(status, stdout + stderr).not.toBe(0);
      expect(stderr).toContain(`Unsupported LVGL ${adapter} source`);
      expect(await Bun.file(adapted).exists()).toBe(false);
      expect(await Bun.file(source).text()).toBe("/* unverified implementation */\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
