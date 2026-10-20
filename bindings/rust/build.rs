use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=LVW_RUST_BINDINGS");
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("missing manifest directory"));
    let configured = env::var_os("LVW_RUST_BINDINGS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../../target/rust-bindings/raw.rs"));
    let source = manifest.join(configured);
    println!("cargo:rerun-if-changed={}", source.display());
    if !source.is_file() {
        panic!(
            "missing generated Rust bindings at {}; run `bun run generate:rust` in the repository, or set LVW_RUST_BINDINGS to an existing raw.rs",
            source.display()
        );
    }
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("missing build output directory"));
    fs::copy(&source, output.join("raw.rs")).unwrap_or_else(|error| {
        panic!(
            "cannot copy Rust bindings from {}: {error}",
            source.display()
        )
    });
}
