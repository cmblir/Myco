//! Existing public consumer boundary checks through real Wry IPC.
fn main() {
    std::process::exit(myco_lib::native_session_compile_probe::run());
}
