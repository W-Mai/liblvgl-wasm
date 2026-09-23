import type { ResourceSource } from "./protocol.ts";

const maxFiles = 32;
const maxFileBytes = 16 * 1024 * 1024;
const maxTotalBytes = 32 * 1024 * 1024;
const encoder = new TextEncoder();

export async function readResources(files: readonly File[]): Promise<ResourceSource[]> {
  if (files.length > maxFiles) throw new Error(`Choose at most ${maxFiles} resource files`);
  const names = new Set<string>();
  let total = 0;
  const resources: ResourceSource[] = [];
  for (const file of files) {
    const name = file.name;
    if (!name || encoder.encode(name).length > 127 ||
        name.includes(":") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw new Error(`Invalid resource name: ${name || "(empty)"}`);
    }
    if (names.has(name)) throw new Error(`Duplicate resource name: ${name}`);
    if (file.size === 0 || file.size > maxFileBytes) {
      throw new Error(`Resource must be between 1 byte and 16 MiB: ${name}`);
    }
    total += file.size;
    if (total > maxTotalBytes) throw new Error("Resources exceed the 32 MiB session limit");
    names.add(name);
    resources.push({ name, bytes: await file.arrayBuffer() });
  }
  return resources;
}
