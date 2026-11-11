const COMMANDS: &[&str] = &["save_to_gallery"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
