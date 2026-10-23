#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -n "${LVW_BUILD_DIR:-}" ]; then
    printf 'Use scripts/build-core.sh for an isolated LVW_BUILD_DIR; website builds use target/wasm\n' >&2
    exit 1
fi
sh "$root/scripts/build-core.sh"
cd "$root"
bun run generate:rust
bun run build:ts
bun run build:browser
bun run build:studio
bun run build:apps
bun run build:ts-app
bun run build:ts-samples
