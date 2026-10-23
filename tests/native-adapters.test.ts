import { expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.each([
  ["timer", "src/misc", "lv_timer.c"], ["animation", "src/misc", "lv_anim.c"],
  ["observer", "src/core", "lv_observer.c"], ["observer", "src/others/observer", "lv_observer.c"],
  ["decoder", "src/image", "lv_image_decoder.c"], ["decoder", "src/draw", "lv_image_decoder.c"],
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

const splitSource = Bun.env.LVW_TEST_OBSERVER_SOURCE;
if (splitSource) test.each(["arc", "slider", "roller", "dropdown"])(
  "split observer adaptation rejects changed %s source and removes all stale units",
  async (changed) => {
    const root = await mkdtemp(join(tmpdir(), "lvw split observer "));
    const files = ["src/others/observer/lv_observer.c",
      ...["arc", "slider", "roller", "dropdown"].map((widget) => `src/widgets/${widget}/lv_${widget}.c`)];
    const outputs = ["lv_observer.c", ...["arc", "slider", "roller", "dropdown"]
      .map((widget) => `lv_observer_${widget}.c`)];
    try {
      for (const file of files) {
        await mkdir(join(root, file, ".."), { recursive: true });
        await copyFile(join(splitSource, file), join(root, file));
      }
      const source = join(root, `src/widgets/${changed}/lv_${changed}.c`);
      await Bun.write(source, "/* unverified implementation */\n");
      await mkdir(join(root, "lvgl-adapted"));
      for (const file of outputs) await Bun.write(join(root, "lvgl-adapted", file), "stale\n");
      await Bun.write(join(root, "check.cmake"),
        `cmake_minimum_required(VERSION 3.25)\ninclude("${resolve("cmake/observer.cmake")}")\n`);
      const child = Bun.spawn(["cmake", `-Dlvgl_SOURCE_DIR=${root}`, "-P", "check.cmake"], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(status, stdout + stderr).not.toBe(0);
      expect(stderr.replace(/\s+/g, " ")).toContain(`Unsupported LVGL observer source: ${source}`);
      for (const file of outputs) expect(await Bun.file(join(root, "lvgl-adapted", file)).exists()).toBe(false);
      expect(await Bun.file(source).text()).toBe("/* unverified implementation */\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
