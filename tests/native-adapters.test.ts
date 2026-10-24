import { expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.each([
  ["timer", "src/misc", "lv_timer.c"], ["animation", "src/misc", "lv_anim.c"],
  ["observer", "src/core", "lv_observer.c"], ["observer", "src/others/observer", "lv_observer.c"],
  ["decoder", "src/image", "lv_image_decoder.c"], ["decoder", "src/draw", "lv_image_decoder.c"],
  ["lodepng", "src/image", "lv_lodepng.c"], ["lodepng", "src/libs/lodepng", "lv_lodepng.c"],
  ["image-cache", "src/misc/cache", "lv_image_cache.c"],
  ["gif", "src/widgets/gif", "lv_gif.c"], ["gif", "src/libs/gif", "lv_gif.c"],
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
      expect(stderr).toContain(`Unsupported LVGL ${adapter === "gif" ? "GIF" : adapter} source`);
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
    const observer = await Bun.file(join(splitSource, "src/core/lv_observer.c")).exists()
      ? "src/core/lv_observer.c" : "src/others/observer/lv_observer.c";
    const files = [observer,
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

const pngSource = Bun.env.LVW_TEST_PNG_SOURCE;
if (pngSource) test.each(["src/libs/lodepng/lodepng.c", "src/libs/bin_decoder/lv_bin_decoder.c"])(
  "PNG adaptation rejects changed %s and removes all generated units",
  async (changed) => {
    const root = await mkdtemp(join(tmpdir(), "lvw png source "));
    const files = ["src/libs/lodepng/lv_lodepng.c", "src/libs/lodepng/lodepng.c",
      "src/libs/bin_decoder/lv_bin_decoder.c"];
    try {
      await mkdir(join(root, "lvgl-adapted"));
      for (const file of files) {
        await mkdir(join(root, file, ".."), { recursive: true });
        await copyFile(join(pngSource, file), join(root, file));
        await Bun.write(join(root, "lvgl-adapted", file.split("/").at(-1)!), "stale\n");
      }
      await Bun.write(join(root, changed), "/* changed source */\n");
      await Bun.write(join(root, "check.cmake"),
        `cmake_minimum_required(VERSION 3.25)\ninclude("${resolve("cmake/lodepng.cmake")}")\n`);
      const child = Bun.spawn(["cmake", `-Dlvgl_SOURCE_DIR=${root}`, "-P", "check.cmake"], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(status, stdout + stderr).not.toBe(0);
      expect(stderr.replace(/\s+/g, " ")).toContain(`Unsupported LVGL lodepng source: ${join(root, changed)}`);
      for (const file of files) expect(await Bun.file(join(root, "lvgl-adapted", file.split("/").at(-1)!)).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

const gifSource = Bun.env.LVW_TEST_GIF_SOURCE;
if (gifSource) test("legacy GIF adaptation rejects changed gifdec bytes and clears both units", async () => {
  const root = await mkdtemp(join(tmpdir(), "lvw gif decoder source "));
  try {
    await mkdir(join(root, "src/libs/gif"), { recursive: true });
    await mkdir(join(root, "lvgl-adapted"));
    await copyFile(join(gifSource, "src/libs/gif/lv_gif.c"), join(root, "src/libs/gif/lv_gif.c"));
    await Bun.write(join(root, "src/libs/gif/gifdec.c"), "/* changed decoder */\n");
    for (const name of ["lv_gif.c", "gifdec.c"]) await Bun.write(join(root, "lvgl-adapted", name), "stale\n");
    await Bun.write(join(root, "check.cmake"),
      `cmake_minimum_required(VERSION 3.25)\ninclude("${resolve("cmake/gif.cmake")}")\n`);
    const child = Bun.spawn(["cmake", `-Dlvgl_SOURCE_DIR=${root}`, "-P", "check.cmake"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(status, stdout + stderr).not.toBe(0);
    expect(stderr.replace(/\s+/g, " ")).toContain(`Unsupported LVGL GIF source: ${join(root, "src/libs/gif/gifdec.c")}`);
    for (const name of ["lv_gif.c", "gifdec.c"]) expect(await Bun.file(join(root, "lvgl-adapted", name)).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
