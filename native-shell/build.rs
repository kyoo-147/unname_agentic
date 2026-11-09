//! Embed every file under assets/ into the binary (see src/assets.rs).

use std::fmt::Write;
use std::path::Path;

fn main() {
    embed("assets", "assets.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") { windows_resources(); }
}

fn windows_resources() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let _root = root;
    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let numbers = format!("{},0", version.replace('.', ","));
    let rc = format!(r#"1 VERSIONINFO
FILEVERSION {numbers}
PRODUCTVERSION {numbers}
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "FileDescription", "Documents\0"
      VALUE "FileVersion", "{version}\0"
      VALUE "ProductName", "Documents\0"
      VALUE "ProductVersion", "{version}\0"
      VALUE "OriginalFilename", "pdf_workspace.exe\0"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#);
    let source = out.join("quiet-md.rc");
    let resource = out.join("quiet-md.res");
    std::fs::write(&source, rc).unwrap();
    let status = std::process::Command::new("rc.exe").arg("/nologo").arg("/fo").arg(&resource).arg(&source).status().expect("Windows SDK rc.exe is required; build from a Visual Studio developer shell");
    assert!(status.success(), "Windows resource compilation failed");
    println!("cargo:rustc-link-arg-bin=pdf_workspace={}", resource.display());
    println!("cargo:rustc-link-arg-bin=pdf_workspace=/STACK:16777216");
    // The GPUI closure graph exceeds MSVC PDB type limits in this preview binary.
    // Unit-test binaries retain their own debug databases.
    if std::env::var("PROFILE").as_deref() == Ok("debug") { println!("cargo:rustc-link-arg-bin=pdf_workspace=/DEBUG:NONE"); }
}

fn embed(source: &str, output: &str) {
    // Read at run time: a compile-time path goes stale when the checkout moves.
    let root = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join(source);
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = vec![];
    collect(&root, &root, &mut files);
    if source == "assets" {
        let safe = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("assets-safe");
        collect(&safe, &safe, &mut files);
        println!("cargo:rerun-if-changed={}", safe.display());
    }
    files.sort();
    let mut out = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for (rel, abs) in files {
        writeln!(out, "    ({rel:?}, include_bytes!({abs:?})),").unwrap();
    }
    out.push_str("];\n");
    let dest = Path::new(&std::env::var("OUT_DIR").unwrap()).join(output);
    std::fs::write(dest, out).unwrap();
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            if dir == root && root.ends_with("assets") && matches!(p.file_name().and_then(|n| n.to_str()), Some("icons" | "branding" | "editor-icons" | "fonts" | "covers")) { continue; }
            collect(root, &p, out);
        } else {
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.push((rel, p.to_string_lossy().into_owned()));
        }
    }
}
