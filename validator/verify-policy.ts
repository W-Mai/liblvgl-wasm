import { verifyHelperPolicy } from "../bindings/typescript/src/feature-validator-policy.ts";

const [helperPath, policyPath] = Bun.argv.slice(2);
if (!helperPath || !policyPath) throw new Error("expected helper and policy paths");
const bytes = await Bun.file(helperPath).bytes();
const policy = await Bun.file(policyPath).json() as { policyVersion: number; features: { name: string; mask: number }[] };
const module = new WebAssembly.Module(bytes);
const instance = new WebAssembly.Instance(module);
verifyHelperPolicy(instance.exports, Object.fromEntries(policy.features.map(({ name, mask }) => [name, mask])), policy.policyVersion);
