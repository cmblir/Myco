fn main() {
    // Windows test executables are linked without the app manifest that
    // tauri-build gives the app, so their Common Controls v6 imports fail with
    // STATUS_ENTRYPOINT_NOT_FOUND before any test runs. CI's Windows job sets
    // MYCO_EMBED_TEST_MANIFEST: the linker then embeds the same manifest into
    // every target, and tauri-build skips its own copy so the app does not get
    // two. Tauri's build.rs does the same for its tests
    // (embed_manifest_for_tests). Without the variable nothing changes.
    println!("cargo:rerun-if-env-changed=MYCO_EMBED_TEST_MANIFEST");
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows_msvc && std::env::var_os("MYCO_EMBED_TEST_MANIFEST").is_some() {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-test-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        if let Err(error) = tauri_build::try_build(attributes) {
            panic!("{error:#}");
        }
        return;
    }
    tauri_build::build();
}
