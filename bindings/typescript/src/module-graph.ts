export interface ModuleRequirement {
  readonly provider: string;
  /** Interface metadata is not validated by orderModuleGraph. */
  readonly interface?: string;
  /** Interface metadata is not validated by orderModuleGraph. */
  readonly version?: number;
  /** Interface metadata is not validated by orderModuleGraph. */
  readonly imports?: readonly unknown[];
}

export interface ModuleDeclaration {
  readonly id: string;
  readonly role: "lib" | "app";
  readonly requires: readonly ModuleRequirement[];
}

export interface ModuleGraph {
  readonly modules: readonly ModuleDeclaration[];
  readonly hostProviders: readonly string[];
}

/** Validate provider identities and dependency edges, and return module IDs in provider-first order. IDs must contain valid Unicode. Ready library IDs and application IDs are ordered lexicographically by UTF-16 code units. Interface metadata is not checked. */
export function orderModuleGraph(graph: ModuleGraph): string[] {
  const nodes = new Map<string, ModuleDeclaration>();
  const hosts = new Set<string>();
  const validId = (id: unknown): id is string => {
    if (typeof id !== "string" || id.length === 0 || id.trim() !== id) return false;
    for (let i = 0; i < id.length; i++) {
      const code = id.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = id.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  };

  for (const id of graph.hostProviders) {
    if (!validId(id)) throw new Error("Invalid host provider ID");
    if (hosts.has(id)) throw new Error(`Duplicate provider ID: ${JSON.stringify(id)}`);
    hosts.add(id);
  }
  for (const module of graph.modules) {
    if (!validId(module.id)) throw new Error("Invalid module ID");
    if (module.role !== "lib" && module.role !== "app") throw new Error(`Invalid module role: ${JSON.stringify(module.id)}`);
    if (nodes.has(module.id) || hosts.has(module.id)) throw new Error(`Duplicate provider ID: ${JSON.stringify(module.id)}`);
    nodes.set(module.id, module);
  }

  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();
  for (const module of graph.modules) {
    const required = new Set<string>();
    for (const { provider } of module.requires) {
      if (!validId(provider)) throw new Error(`Invalid provider ID: ${JSON.stringify(module.id)}`);
      if (provider === module.id) throw new Error(`Self dependency: ${JSON.stringify(module.id)} -> ${JSON.stringify(provider)}`);
      if (hosts.has(provider)) continue;
      const target = nodes.get(provider);
      if (!target) throw new Error(`Missing provider: ${JSON.stringify(module.id)} -> ${JSON.stringify(provider)}`);
      if (target.role !== "lib") throw new Error(`App cannot be a provider: ${JSON.stringify(module.id)} -> ${JSON.stringify(provider)}`);
      required.add(provider);
    }
    dependencies.set(module.id, required);
    for (const provider of required) {
      const consumers = dependents.get(provider) ?? [];
      consumers.push(module.id);
      dependents.set(provider, consumers);
    }
  }

  const remaining = new Map([...dependencies].map(([id, providers]) => [id, providers.size]));
  const ready = [...nodes.keys()].filter((id) => remaining.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const consumer of dependents.get(id) ?? []) {
      const count = remaining.get(consumer)! - 1;
      remaining.set(consumer, count);
      if (count === 0) ready.push(consumer);
    }
    ready.sort();
  }
  if (order.length !== nodes.size) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    for (const start of [...nodes.keys()].sort()) {
      if (visited.has(start)) continue;
      const stack: { id: string; next: string[] }[] = [{ id: start, next: [...dependencies.get(start)!].sort().reverse() }];
      visiting.add(start);
      while (stack.length) {
        const frame = stack[stack.length - 1]!;
        const next = frame.next.pop();
        if (next === undefined) {
          visiting.delete(frame.id);
          visited.add(frame.id);
          stack.pop();
        } else if (visiting.has(next)) {
          const first = stack.findIndex((item) => item.id === next);
          throw new Error(`Library dependency cycle: ${[...stack.slice(first).map((item) => item.id), next].map((id) => JSON.stringify(id)).join(" -> ")}`);
        } else if (!visited.has(next)) {
          visiting.add(next);
          stack.push({ id: next, next: [...dependencies.get(next)!].sort().reverse() });
        }
      }
    }
    throw new Error("Library dependency cycle");
  }
  // Place apps after all libraries, including unrelated libraries.
  return [...order.filter((id) => nodes.get(id)!.role === "lib"), ...order.filter((id) => nodes.get(id)!.role === "app").sort()];
}
