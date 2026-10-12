//! 发布包入口。有两种形态:
//!
//! 1. 文件夹版: 同目录下就有 runtime\node.exe 与 src\app.ts, 直接启动。
//! 2. 单文件版: 本 exe 的**尾部追加**了一份文件包(不压缩, 就是原样拼接),
//!    首次运行时展开到旁边(或 %LOCALAPPDATA%), 之后就直接启动。
//!
//! 打包格式(exe 尾部):
//!   [原来的 exe] [文件1] [文件2] ... [索引] [索引偏移 u64] [魔数 u32]
//!   索引: [条目数 u32] 然后每条 [名字长度 u16] [名字] [偏移 u64] [大小 u64]
#![windows_subsystem = "windows"]

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

/// CREATE_NO_WINDOW: 不留控制台窗口
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 尾部魔数, 用来认出自解压包("LVP1")
const MAGIC: u32 = 0x3150_564C;
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

/// 自解压包里的一个文件。
struct Entry {
    name: String,
    offset: u64,
    size: u64,
}

/// 读自己尾巴上的索引。不是自解压包就返回 None。
fn read_index(exe: &Path) -> Option<Vec<Entry>> {
    let mut file = File::open(exe).ok()?;
    let length = file.metadata().ok()?.len();
    if length < 12 {
        return None;
    }
    file.seek(SeekFrom::End(-12)).ok()?;
    let mut tail = [0u8; 12];
    file.read_exact(&mut tail).ok()?;
    let magic = u32::from_le_bytes([tail[8], tail[9], tail[10], tail[11]]);
    if magic != MAGIC {
        return None;
    }
    let index_offset = u64::from_le_bytes(tail[0..8].try_into().ok()?);
    if index_offset >= length {
        return None;
    }
    file.seek(SeekFrom::Start(index_offset)).ok()?;
    let mut count_buf = [0u8; 4];
    file.read_exact(&mut count_buf).ok()?;
    let count = u32::from_le_bytes(count_buf);
    let mut entries = Vec::new();
    for _ in 0..count {
        let mut name_len_buf = [0u8; 2];
        file.read_exact(&mut name_len_buf).ok()?;
        let name_len = u16::from_le_bytes(name_len_buf) as usize;
        let mut name_buf = vec![0u8; name_len];
        file.read_exact(&mut name_buf).ok()?;
        let mut numbers = [0u8; 16];
        file.read_exact(&mut numbers).ok()?;
        entries.push(Entry {
            name: String::from_utf8(name_buf).ok()?,
            offset: u64::from_le_bytes(numbers[0..8].try_into().ok()?),
            size: u64::from_le_bytes(numbers[8..16].try_into().ok()?),
        });
    }
    Some(entries)
}

/// 展开文件包到 target。
fn extract(exe: &Path, entries: &[Entry], target: &Path) -> Result<(), String> {
    let mut source = File::open(exe).map_err(|e| e.to_string())?;
    for entry in entries {
        let out_path = target.join(entry.name.replace('/', "\\"));
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("建目录失败 {}: {e}", parent.display()))?;
        }
        // 已经展开过且大小一致就跳过(重复运行不必重写 88MB)
        if let Ok(meta) = fs::metadata(&out_path) {
            if meta.len() == entry.size {
                continue;
            }
        }
        source.seek(SeekFrom::Start(entry.offset)).map_err(|e| e.to_string())?;
        let mut remaining = entry.size;
        let mut buffer = vec![0u8; 512 * 1024];
        let mut out = File::create(&out_path).map_err(|e| format!("写入失败 {}: {e}", out_path.display()))?;
        while remaining > 0 {
            let want = remaining.min(buffer.len() as u64) as usize;
            source.read_exact(&mut buffer[..want]).map_err(|e| e.to_string())?;
            out.write_all(&buffer[..want]).map_err(|e| e.to_string())?;
            remaining -= want as u64;
        }
    }
    Ok(())
}

/// 决定展开到哪里: 先试 exe 旁边(便携), 不行就退到 %LOCALAPPDATA%。
fn pick_target(exe_dir: &Path) -> PathBuf {
    let portable = exe_dir.join("LoL_Voice_data");
    if fs::create_dir_all(&portable).is_ok() {
        let probe = portable.join(".write-test");
        if fs::write(&probe, b"1").is_ok() {
            let _ = fs::remove_file(&probe);
            return portable;
        }
    }
    let fallback = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("LoL_Voice");
    let _ = fs::create_dir_all(&fallback);
    fallback
}

/// 启动后端(找不到 node 或 app.ts 就报错)。
fn launch(dir: &Path) -> Result<(), String> {
    let node = dir.join("runtime").join("node.exe");
    let app = dir.join("src").join("app.ts");
    if !node.exists() || !app.exists() {
        return Err(format!("缺少文件: {}", if !node.exists() { node.display().to_string() } else { app.display().to_string() }));
    }
    std::process::Command::new(&node)
        .arg(&app)
        .current_dir(dir)
        .env("LEAGUE_VOICE_RELEASE", "1")
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn main() {
    let exe = std::env::current_exe().ok();
    let exe = match exe {
        Some(path) => path,
        None => {
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

    // 单文件版: 先展开
    let entries = read_index(&exe);
    let run_dir = match entries {
        Some(entries) => {
            let target = pick_target(&exe_dir);
            if let Err(error) = extract(&exe, &entries, &target) {
                alert(&format!("展开文件失败：{error}"));
                return;
            }
            target
        }
        None => exe_dir,
    };

    if let Err(error) = launch(&run_dir) {
        alert(&format!("启动失败：{error}\n\n请把整个文件夹一起复制, 不要只拿这一个 exe。", ));
    }
}
