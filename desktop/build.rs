//! 给编译出的 exe 打上图标与版本信息(图标是使用者设计的 assets/ico/voicepack.ico)。
fn main() {
    println!("cargo:rerun-if-changed=../assets/ico/voicepack.ico");
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../assets/ico/voicepack.ico");
        res.set("FileDescription", "LoL Voice");
        res.set("ProductName", "LoL Voice");
        res.set("CompanyName", "ChosenLoLskins");
        res.set("FileVersion", "0.0.1.0");
        res.set("ProductVersion", "0.0.1.0");
        if let Err(error) = res.compile() {
            println!("cargo:warning=图标资源编译失败(不影响功能): {error}");
        }
    }
}
