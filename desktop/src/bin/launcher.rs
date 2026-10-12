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

/// 找到主窗口并把它显示出来。
///
/// 窗口标题来自 web/index.html 的 <title>, 是固定的 —— 这样即使托盘图标没显示出来,
/// 再双击一次程序也能把窗口叫回来(同时把"从任务栏移除"的扩展样式一起还原)。
fn show_our_window() -> bool {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn FindWindowW(class_name: *const u16, window_name: *const u16) -> isize;
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_APPWINDOW: isize = 0x0004_0000;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    const SW_SHOW: i32 = 5;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    // 注意: 必须带上类名 —— 只给标题的话 FindWindowW 返回 0(实测),
    // 因为 tao 的窗口类是每进程注册的, 传 null 类名时找不到它。
    let class_name = wide("Window Class");
    let title = wide("LoL Voice"); // 与外壳的 with_title 一致
    let hwnd = unsafe { FindWindowW(class_name.as_ptr(), title.as_ptr()) };
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let restored = (ex | WS_EX_APPWINDOW) & !WS_EX_TOOLWINDOW;
        if restored != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, restored);
            SetWindowPos(
                hwnd,
                0,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );
        }
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
    }
    true
}

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
        // 已经在运行: 把它的窗口叫回来。
        // 这样即使托盘图标没显示出来(有些机器上会被系统压掉), 再双击一次也能恢复, 不会"卡在后台回不来"。
        if !show_our_window() {
            alert("软件已经在运行了, 但没能把窗口叫回来。\n\n可以到任务管理器结束 node.exe 与 voice-shell.exe 再重新打开。");
        }
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
