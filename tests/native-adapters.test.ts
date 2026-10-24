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
  ["tinyttf", "src/font/tiny_ttf", "lv_tiny_ttf.c"], ["tinyttf", "src/libs/tiny_ttf", "lv_tiny_ttf.c"],
  ["font", "src/draw", "lv_draw_label.c"], ["outline", "src/draw/sw", "lv_draw_sw_letter.c"],
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

const tinyttfSource = Bun.env.LVW_TEST_TINYTTF_SOURCE;
if (tinyttfSource) test("legacy TinyTTF rejects file streams and clears its adapted unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "lvw tinyttf source "));
  try {
    await mkdir(join(root, "src/libs/tiny_ttf"), { recursive: true });
    await mkdir(join(root, "lvgl-adapted"));
    await copyFile(join(tinyttfSource, "src/libs/tiny_ttf/lv_tiny_ttf.c"), join(root, "src/libs/tiny_ttf/lv_tiny_ttf.c"));
    await Bun.write(join(root, "lvgl-adapted/lv_tiny_ttf.c"), "stale\n");
    await Bun.write(join(root, "check.cmake"),
      `cmake_minimum_required(VERSION 3.25)\nfunction(lvw_config_flag name)\nset(LV_TINY_TTF_FILE_SUPPORT 1 PARENT_SCOPE)\nendfunction()\ninclude("${resolve("cmake/tinyttf.cmake")}")\n`);
    const child = Bun.spawn(["cmake", `-Dlvgl_SOURCE_DIR=${root}`, "-P", "check.cmake"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(status, stdout + stderr).not.toBe(0);
    expect(stderr.replace(/\s+/g, " ")).toContain("Legacy TinyTTF file streams require independent adaptation");
    expect(await Bun.file(join(root, "lvgl-adapted/lv_tiny_ttf.c")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const thorvgSources = [resolve("target/sources/lvgl"), Bun.env.LVW_TEST_THORVG_SOURCE].filter(Boolean) as string[];
for (const sourceRoot of thorvgSources) test.each([
  "src/libs/thorvg/config.h", "src/libs/thorvg/tvgSwRenderer.cpp", "src/draw/sw/lv_draw_sw_vector.c",
  ...(sourceRoot === Bun.env.LVW_TEST_THORVG_SOURCE ? ["src/libs/thorvg/tvgSvgLoader.cpp"] : []),
])("ThorVG adaptation rejects changed %s and removes all stale units", async (changed) => {
  const root = await mkdtemp(join(tmpdir(), "lvw thorvg source "));
  const files = ["src/libs/thorvg/config.h", "src/libs/thorvg/tvgSwRenderer.cpp",
    "src/libs/thorvg/tvgSvgLoader.cpp", "src/draw/sw/lv_draw_sw_vector.c"];
  try {
    await mkdir(join(root, "lvgl-adapted"));
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await copyFile(join(sourceRoot, file), join(root, file));
      if (!file.endsWith("config.h")) await Bun.write(join(root, "lvgl-adapted", file.split("/").at(-1)!), "stale\n");
    }
    await Bun.write(join(root, changed), "/* changed source */\n");
    await Bun.write(join(root, "check.cmake"),
      `cmake_minimum_required(VERSION 3.25)\nfunction(lvw_config_flag name)\nset(LV_USE_VECTOR_GRAPHIC 1 PARENT_SCOPE)\nendfunction()\ninclude("${resolve("cmake/thorvg.cmake")}")\n`);
    const child = Bun.spawn(["cmake", `-Dlvgl_SOURCE_DIR=${root}`, "-P", "check.cmake"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(status, stdout + stderr).not.toBe(0);
    expect(stderr.replace(/\s+/g, " ")).toContain(`Unsupported ThorVG source: ${join(root, changed)}`);
    for (const file of files.filter((path) => !path.endsWith("config.h"))) {
      expect(await Bun.file(join(root, "lvgl-adapted", file.split("/").at(-1)!)).exists()).toBe(false);
    }
    expect(await Bun.file(join(root, changed)).text()).toBe("/* changed source */\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
