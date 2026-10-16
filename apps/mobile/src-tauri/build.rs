fn main() {
    // Android（minSdk 29）：压缩动态重定位表（Android 9+ 支持 RELR），动态库能小约 0.7MB
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,--pack-dyn-relocs=android+relr");
    }
    tauri_build::build()
}
