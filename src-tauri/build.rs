use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dist = manifest.join("..").join("ui").join("dist").join("index.html");
    let src = manifest.join("..").join("ui").join("src").join("main.tsx");
    println!("cargo:rerun-if-changed=../ui/dist/index.html");
    println!("cargo:rerun-if-changed=../ui/src/main.tsx");
    match (std::fs::metadata(&dist), std::fs::metadata(&src)) {
        (Ok(dist_meta), Ok(src_meta)) => {
            if let (Ok(dist_time), Ok(src_time)) = (dist_meta.modified(), src_meta.modified()) {
                if src_time > dist_time {
                    println!(
                        "cargo:warning=ui/dist 比 ui/src 旧；改 UI 后请先在 ui/ 执行 npm run build，再 cargo build"
                    );
                }
            }
        }
        (Err(_), _) => {
            println!("cargo:warning=缺少 ui/dist/index.html；请先在 ui/ 执行 npm run build");
        }
        _ => {}
    }
    tauri_build::build();
}
