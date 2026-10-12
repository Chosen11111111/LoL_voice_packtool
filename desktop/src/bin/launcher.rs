//! 发布包入口。
//!
//! 发布包结构(用户看到的只有两样东西):
//!   LoL_Voice.exe        启动入口(本程序, 带图标)
//!   resource\            所有东西都在这里面
//!       runtime\node.exe     自带的 Node 运行时(用户不用装任何环境)
//!       src\  web\  assets\  程序本体与界面
//!       desktop\voice-shell.exe  无边框窗口外壳
//!
//! 另外兼容两种老位置(开发目录里直接跑, 或早期没有 resource\ 的包):
//!   exe 旁边直接就有 src\ 与 runtime\。
#![windows_subsystem = "windows"]

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

/// CREATE_NO_WINDOW: 不留控制台窗口
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 默认端口(与 src/core/config.ts 里的默认值一致)
const DEFAULT_PORT: u16 = 43110;

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    fn FindWindowW(class_name: *const u16, window_name: *const u16) -> isize;
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn alert(text: &str) {
    let body = wide(text);
    let title = wide("LoL Voice");
    unsafe {
        MessageBoxW(0, body.as_ptr(), title.as_ptr(), 0x0001_0000);
    }
}

/// 找到主窗口并显示出来(窗口类名是 tao 注册的 "Window Class")。
fn show_our_window() -> bool {
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_APPWINDOW: isize = 0x0004_0000;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    let class_name = wide("Window Class");
    let title = wide("LoL Voice");
    let hwnd = unsafe { FindWindowW(class_name.as_ptr(), title.as_ptr()) };
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let restored = (ex | WS_EX_APPWINDOW) & !WS_EX_TOOLWINDOW;
        if restored != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, restored);
            SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0020);
        }
        ShowWindow(hwnd, 5);
        SetForegroundWindow(hwnd);
    }
    true
}

/// 程序本体在哪: 优先 exe 旁边的 resource\, 否则就用 exe 自己的目录。
fn resolve_root(exe_dir: &Path) -> PathBuf {
    let nested = exe_dir.join("resource");
    if nested.join("src").join("app.ts").exists() {
        return nested;
    }
    exe_dir.to_path_buf()
}

fn main() {
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => {
            alert("无法确定程序位置");
            return;
        }
    };
    let exe_dir = exe.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));

    // 已经在运行? 那就把窗口叫回来, 不要开第二个
    if std::net::TcpStream::connect(("127.0.0.1", DEFAULT_PORT)).is_ok() {
        if !show_our_window() {
            alert("软件已经在运行了, 但没能把窗口叫回来。\n\n可以到任务管理器结束 node.exe 与 voice-shell.exe 再重新打开。");
        }
        return;
    }

    let root = resolve_root(&exe_dir);
    let node = root.join("runtime").join("node.exe");
    let app = root.join("src").join("app.ts");
    if !node.exists() || !app.exists() {
        let missing = if !node.exists() { node.display().to_string() } else { app.display().to_string() };
        alert(&format!(
            "文件不完整，缺少：\n{missing}\n\n请把 LoL_Voice.exe 与 resource 文件夹放在一起，不要只拿一个文件。"
        ));
        return;
    }

    let started = std::process::Command::new(&node)
        .arg(&app)
        .current_dir(&root)
        .env("LEAGUE_VOICE_RELEASE", "1")
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    if let Err(error) = started {
        alert(&format!("启动失败：{error}"));
    }
}
