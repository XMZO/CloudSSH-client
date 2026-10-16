// 桌面调试入口（tauri dev）：在电脑上快速迭代移动端界面；正式产物是 Android APK
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cloudssh_mobile_lib::run()
}
