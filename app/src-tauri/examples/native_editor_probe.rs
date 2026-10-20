//! Production editor commands through an isolated real Wry IPC transport.
#[cfg(feature = "native-index-probe")]
fn main() {
    std::process::exit(myco_lib::native_editor_probe::run());
}

#[cfg(not(feature = "native-index-probe"))]
fn main() {
    eprintln!("native_editor_probe requires --features native-index-probe");
    std::process::exit(1);
}
