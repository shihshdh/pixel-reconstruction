fn main() {
    // 只为这两个自定义命令生成权限，站点能调用的本地能力仅限于此
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["save_work_file", "open_works_folder"]),
        ),
    )
    .expect("failed to run tauri-build");
}
