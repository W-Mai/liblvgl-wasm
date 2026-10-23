use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=LVW_RUST_BINDINGS");
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("missing manifest directory"));
    let configured = env::var_os("LVW_RUST_BINDINGS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(if cfg!(feature = "bundled-bindings") {
                "generated/raw.rs"
            } else {
                "../../target/rust-bindings/raw.rs"
            })
        });
    let source = manifest.join(configured);
    println!("cargo:rerun-if-changed={}", source.display());
    if !source.is_file() {
        panic!(
            "missing generated Rust bindings at {}; restore the exported SDK's generated/raw.rs, run `bun run generate:rust` for a source checkout, or set LVW_RUST_BINDINGS to an existing raw.rs",
            source.display()
        );
    }
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("missing build output directory"));
    // Do not carry read-only package permissions into Cargo's generated sources.
    let temporary = output.join("raw.rs.tmp");
    fs::read(&source)
        .and_then(|bytes| fs::write(&temporary, bytes))
        .and_then(|()| fs::rename(&temporary, output.join("raw.rs")))
        .unwrap_or_else(|error| {
            panic!(
                "cannot copy Rust bindings from {}: {error}",
                source.display()
            )
        });
}
