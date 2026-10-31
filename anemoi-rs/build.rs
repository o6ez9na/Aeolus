// The agent speaks the same NodeAgent service as the Python one, generated from
// the very .proto the panel uses, so the two sides cannot drift.
//
// protox compiles the .proto in pure Rust: no protoc on the build machine, which
// keeps cross-compiling for routers down to a Rust toolchain and a linker.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../proto/anemoi/v1/agent.proto";
    println!("cargo:rerun-if-changed={proto}");

    let descriptors = protox::compile(["anemoi/v1/agent.proto"], ["../proto"])?;
    tonic_prost_build::configure()
        // The server half is only used by the tests, which stand in for the
        // panel; release builds drop it as dead code.
        .build_server(true)
        .compile_fds(descriptors)?;
    Ok(())
}
