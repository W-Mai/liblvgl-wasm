import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test("Pages includes its runtime assets and excludes build caches", async () => {
  const sourceFiles = [...files("studio/src").filter((file) => file.endsWith(".ts")), "examples/browser/main.ts", "examples/browser/index.html", "studio/index.html"];
  const paths = new Set<string>();
  for (const name of sourceFiles) {
    const text = readFileSync(name, "utf8");
    for (const match of text.matchAll(/["'](?:\.\.\/|\/)(target\/[A-Za-z0-9_./-]+)["']/g)) paths.add(match[1]!);
  }
  expect(paths.size).toBeGreaterThan(0);
  const temp = mkdtempSync(join(tmpdir(), "lvw-pages-"));
  try {
    const source = join(temp, "source"), site = join(temp, "site");
    for (const path of paths) {
      const file = join(source, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, path);
    }
    for (const path of ["target/rust/debug/deps/cache", "target/wasm/CMakeCache.txt", "target/studio/cache", "target/apps/rust/build/cache", "target/apps/ts/samples/cache.js", "target/validator/build/cache"]) {
      const file = join(source, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "cache");
    }
    const script = "scripts/assemble-pages-target.py";
    const result = Bun.spawn(["python3", "-B", script, source, site], { stdout: "ignore", stderr: "inherit" });
    expect(await result.exited).toBe(0);
    expect(new Set(files(join(site, "target")).map((file) => relative(site, file).split(sep).join("/")))).toEqual(paths);
    for (const path of paths) expect(readFileSync(join(site, path), "utf8")).toBe(path);
    rmSync(site, { recursive: true });
    const missing = [...paths][0]!;
    unlinkSync(join(source, missing));
    const checkFailure = `import runpy, sys
script, source, site, expected_type, expected_message = sys.argv[1:]
sys.argv = [script, source, site]
try:
    runpy.run_path(script, run_name="__main__")
except (FileNotFoundError, ValueError) as error:
    if type(error).__name__ == expected_type and str(error) == expected_message:
        raise SystemExit(73)
    raise
`;
    const rejects = async (type: string, message: string) => {
      const failure = Bun.spawn(["python3", "-B", "-c", checkFailure, script, source, site, type, message], { stdout: "ignore", stderr: "inherit" });
      expect(await failure.exited).toBe(73);
      expect(() => readdirSync(join(site, "target"))).toThrow();
    };
    await rejects("FileNotFoundError", `missing Pages artifact: ${join(source, missing)}`);
    writeFileSync(join(source, missing), missing);

    const asset = join(source, "target/apps/c/app.wasm"), directory = dirname(asset);
    const external = join(temp, "external"), externalAsset = join(external, "app.wasm");
    mkdirSync(external);
    writeFileSync(externalAsset, "outside target");
    unlinkSync(asset);
    symlinkSync(externalAsset, asset, "file");
    await rejects("ValueError", `Pages artifact contains a symlink: ${asset}`);
    unlinkSync(asset);
    rmSync(directory, { recursive: true });
    symlinkSync(external, directory, "dir");
    await rejects("ValueError", `Pages artifact contains a symlink: ${directory}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
