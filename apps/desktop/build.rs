fn main() {
    // Stamp the build time (unix seconds) into the binary so the running app
    // can compare itself to the latest GitHub release asset's upload time and
    // prompt the user to upgrade when a newer build is published (see
    // update_check.rs). In CI release builds the target is clean, so this
    // re-stamps to the build time of the shipped binary; for local incremental
    // builds it only re-runs when build.rs changes, which is fine - the update
    // check is a no-op for un-stamped / dev binaries.
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=DUCKLE_BUILD_EPOCH={epoch}");
    // Force this script to re-run on EVERY build so the stamped epoch is always
    // the actual build time. Pinning rerun to build.rs alone left local rebuilds
    // carrying the very first build's timestamp, which made the update check
    // report "a newer build is available" even when the local build was newer
    // than the release. Referencing a path that never exists makes Cargo treat
    // the script as always-dirty and re-run it.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=.duckle-always-restamp-build-epoch");
    tauri_build::build()
}
