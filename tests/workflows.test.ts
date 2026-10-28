import { expect, test } from "bun:test";

type Workflow = {
  on: Record<string, any>;
  jobs: Record<string, any>;
};

const quality = Bun.YAML.parse(await Bun.file(".github/workflows/quality.yml").text()) as Workflow;
const release = Bun.YAML.parse(await Bun.file(".github/workflows/package.yml").text()) as Workflow;

test("package publication requires the same-commit default quality workflow", () => {
  expect(quality.on.push.branches).toContain("**");
  expect(quality.on.push["tags-ignore"]).toContain("v*");
  expect(release.on.push.tags).toContain("v*");
  expect(Object.hasOwn(release.on, "workflow_dispatch")).toBe(true);
  expect(Object.hasOwn(quality.on, "workflow_call")).toBe(true);
  expect(release.jobs.quality.uses).toBe("./.github/workflows/quality.yml");
  expect(release.jobs.quality.with?.legacy_checks ?? false).toBe(false);
  expect(release.jobs.quality.if).toBeUndefined();
  expect(release.jobs.quality["continue-on-error"]).toBeUndefined();
  const job = release.jobs.package;
  expect([job.needs].flat()).toContain("quality");
  expect(job.if).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
  for (const steps of [quality.jobs.quality.steps, job.steps]) {
    const checkout = steps.filter((step: any) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout).toHaveLength(1);
    expect(checkout[0].with?.ref).toBeUndefined();
    expect(checkout[0].if).toBeUndefined();
    expect(checkout[0]["continue-on-error"]).toBeUndefined();
    const revision = steps.filter((step: any) => step.run === 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(revision).toHaveLength(1);
    expect(revision[0].if).toBeUndefined();
    expect(revision[0]["continue-on-error"]).toBeUndefined();
  }
  const steps = job.steps;
  const indexOf = (command: string) => steps.findIndex((step: any) => step.run?.includes(command));
  const exported = indexOf("export-package");
  const verified = indexOf("verify-package");
  const exercised = indexOf("./tests/package-consumer.test.ts");
  const archived = indexOf("tar -C target");
  const uploaded = steps.findIndex((step: any) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(exported).toBeGreaterThanOrEqual(0);
  expect(verified).toBeGreaterThan(exported);
  expect(exercised).toBeGreaterThan(verified);
  expect(archived).toBeGreaterThan(exercised);
  expect(uploaded).toBeGreaterThan(archived);
  expect(steps[archived].run).toContain("${GITHUB_SHA}");
  expect(steps[uploaded].with.name).toBe("liblvgl-wasm-package-${{ github.sha }}");
  expect(steps[exercised].name).toBe("Run relocated browser and Rust acceptance");
  expect(steps[exercised].env.LVW_TEST_BROWSER).toBe("/usr/bin/google-chrome-stable");
  expect(steps[exercised].run).toContain('test -x "$LVW_TEST_BROWSER"');
  expect(steps[exported].run).not.toContain("--allow-dirty");
  for (const index of [exported, verified, exercised, archived, uploaded]) {
    expect(steps[index].if).toBeUndefined();
    expect(steps[index]["continue-on-error"]).toBeUndefined();
  }
});

test("legacy compatibility checks require an explicit workflow input", () => {
  for (const event of ["workflow_call", "workflow_dispatch"]) {
    expect(quality.on[event].inputs.legacy_checks.type).toBe("boolean");
    expect(quality.on[event].inputs.legacy_checks.default).toBe(false);
  }
  const job = quality.jobs.quality;
  expect(job.if).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
  const core = job.steps.filter((step: any) => step.run === "bun run quality");
  expect(core).toHaveLength(1);
  expect(core[0].if).toBeUndefined();
  expect(core[0]["continue-on-error"]).toBeUndefined();
  for (const command of ["bun run check:compatibility", "bun run check:software"]) {
    const matching = job.steps.filter((step: any) => step.run === command);
    expect(matching).toHaveLength(1);
    expect(matching[0].if).toBe("${{ inputs.legacy_checks }}");
    expect(matching[0]["continue-on-error"]).toBeUndefined();
  }
});
