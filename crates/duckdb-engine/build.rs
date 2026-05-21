fn main() {
    // libduckdb-sys on Windows references the Restart Manager API
    // (RmStartSession, RmEndSession, ...) which lives in rstrtmgr.lib.
    // Add it to the link line for every downstream binary that pulls
    // this crate in (apps/desktop, integration tests, doc-tests).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=dylib=rstrtmgr");
    }
}
