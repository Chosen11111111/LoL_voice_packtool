//! 发布包的入口: 双击它就把程序带起来(用户不需要装任何环境)。
//!
//! 它做的事: 找到同目录下的 runtime\node.exe 与 src\app.ts, 以后台方式启动后端
//! (不弹控制台窗口), 然后自己退出。后端随后会打开我们自己的无边框窗口。
//! 出问题时弹一个消息框说明, 而不是默默什么都不发生。
#![windows_subsystem = "windows"]

use std::os::windows::process::CommandExt;
use std::path::PathBuf;

/// CREATE_NO_WINDOW: 不留控制台窗口
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn alert(text: &str) {
    let body = wide(text);
    let title = wide("LoL Voice");
    unsafe {
        MessageBoxW(0, body.as_ptr(), title.as_ptr(), 0x0001_0000); // MB_ICONERROR
    }
}

/// 默认端口(与 src/core/config.ts 里的默认值一致)。
const DEFAULT_PORT: u16 = 43110;

fn main() {
    let exe = std::env::current_exe().ok();
    let dir: PathBuf = exe
        .as_ref()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));

    let node = dir.join("runtime").join("node.exe");
    let app = dir.join("src").join("app.ts");
    if !node.exists() || !app.exists() {
        alert("文件不完整：请把整个文件夹一起解压/复制，不要只拿这一个 exe。\n\n缺少 runtime\\node.exe 或 src\\app.ts。");
        return;
    }

    // 已经在运行时, 后端会因端口被占用直接退出; 而发布包没有控制台窗口,
    // 用户只会看到"点了没反应" —— 所以先探一下端口, 直接告诉他。
    if std::net::TcpStream::connect(("127.0.0.1", DEFAULT_PORT)).is_ok() {
        alert("软件已经在运行了。\n\n看不到窗口的话, 看看右下角托盘里的小图标(可能在\"隐藏的图标\"里)。");
        return;
    }

    let started = std::process::Command::new(&node)
        .arg(&app)
        .current_dir(&dir)
        .env("LEAGUE_VOICE_RELEASE", "1")
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    if let Err(error) = started {
        alert(&format!("启动失败：{error}"));
    }
}
