//! 语音包切换器的原生外壳(无边框窗口 + WebView2)。
//!
//! 为什么需要它: 浏览器 `--app=` 那条标题栏是浏览器自己画的, 外部改不掉;
//! 这里用 tao 建**无边框**窗口, 标题栏由页面自己画(web/ 里的 .app-titlebar)。
//! 页面上的按键通过 wry 的 IPC 传回来执行: 最小化 / 收进右下角托盘 / 关闭 / 拖动。
//!
//! 用法: voice-shell.exe [url]   默认 http://127.0.0.1:43110/
//! 窗口默认 800x600(与原来浏览器窗口一致), 可拖边缘缩放。

use tao::dpi::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::WindowExtWindows;
use tao::window::{Icon, WindowBuilder};

mod tray;
use wry::WebViewBuilder;

// tao 的 set_skip_taskbar 走 ITaskbarList::DeleteTab —— 只是临时删掉按钮,
// 窗口一显示又回来。要真正不进任务栏, 必须改窗口的扩展样式:
// 去掉 WS_EX_APPWINDOW(它强制显示任务栏按钮), 加上 WS_EX_TOOLWINDOW。
#[link(name = "user32")]
unsafe extern "system" {
    fn GetWindowLongPtrW(hwnd: isize, nindex: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, nindex: i32, value: isize) -> isize;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
}

const GWL_EXSTYLE: i32 = -20;
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WS_EX_APPWINDOW: isize = 0x0004_0000;

/// 让窗口出现在任务栏(show=true)或从任务栏消失(show=false)。
fn set_taskbar_visible(hwnd: isize, show: bool) {
    unsafe {
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        ex = if show {
            (ex & !WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW
        } else {
            (ex & !WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
        // 样式改了要通知系统重算非客户区, 否则任务栏不会立刻更新
        SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0020);
    }
}

#[derive(Debug, Clone)]
enum Action {
    Minimize,
    ToTray,
    ShowWindow,
    ToggleMaximize,
    /// 从小条恢复成正常窗口
    Restore,
    Close,
    Drag,
}

/// 从 PNG 文件读出 RGBA(tao 的 Icon 只接受原始像素, 没有 from_path)。
/// 图标由使用者在 assets/ico/voicepack-icon-512.png 提供, 路径由 app.ts 传进来。
fn load_png_rgba(path: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader.output_buffer_size().ok_or("无法确定 PNG 缓冲区大小")?;
    let mut buf = vec![0u8; size];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let bytes = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => bytes.to_vec(),
        png::ColorType::Rgb => bytes
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        other => return Err(format!("不支持的 PNG 颜色类型: {other:?}")),
    };
    Ok((rgba, info.width, info.height))
}

/// 把 RGBA 缩到 size×size(按 alpha 加权, 免得边缘发黑)。
fn resize_rgba_to(rgba: &[u8], width: u32, height: u32, size: u32) -> Vec<u8> {
    let mut out = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let x0 = x * width / size;
            let x1 = (((x + 1) * width) / size).max(x0 + 1);
            let y0 = y * height / size;
            let y1 = (((y + 1) * height) / size).max(y0 + 1);
            let (mut r, mut g, mut b, mut a, mut n) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * width + sx) * 4) as usize;
                    let alpha = rgba[i + 3] as u32;
                    r += rgba[i] as u32 * alpha;
                    g += rgba[i + 1] as u32 * alpha;
                    b += rgba[i + 2] as u32 * alpha;
                    a += alpha;
                    n += 1;
                }
            }
            let o = ((y * size + x) * 4) as usize;
            if a > 0 {
                out[o] = (r / a) as u8;
                out[o + 1] = (g / a) as u8;
                out[o + 2] = (b / a) as u8;
            }
            out[o + 3] = if n > 0 { (a / n) as u8 } else { 0 };
        }
    }
    out
}

/// 窗口图标(任务栏 / Alt-Tab 用)。
fn load_window_icon(path: &str) -> Option<Icon> {
    match load_png_rgba(path) {
        Ok((rgba, w, h)) => Icon::from_rgba(rgba, w, h).ok(),
        Err(error) => {
            eprintln!("[voice-shell] 读取窗口图标失败 {path}: {error}");
            None
        }
    }
}

/// 建托盘图标(收进右下角时才有; 显示窗口后会被丢弃, 图标随之消失)。
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_else(|| "http://127.0.0.1:43110/".to_string());
    // 第二个参数(可选): 托盘图标的路径, 由 app.ts 传进来。优先是 .ico ——
    // 托盘图标本来就是用 LoadImageW(IMAGE_ICON) 装的, 它认 ico 不认 PNG。
    let icon_path: Option<String> = args.next();
    // 第三个参数(可选): 窗口/任务栏图标的 PNG。tao 的 Icon 只能从 rgba 构造, 用不了 ico。
    let window_icon_path: Option<String> = args.next();

    let event_loop = EventLoopBuilder::<Action>::with_user_event().build();
    let proxy: EventLoopProxy<Action> = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("LoL Voice")
        .with_decorations(false) // 关键: 不要系统标题栏
        .with_resizable(true)
        .with_inner_size(LogicalSize::new(800.0, 600.0))
        .with_min_inner_size(LogicalSize::new(680.0, 520.0))
        .build(&event_loop)?;
    if let Some(icon) = window_icon_path
        .as_deref()
        .or(icon_path.as_deref())
        .and_then(load_window_icon)
    {
        window.set_window_icon(Some(icon)); // 任务栏 / Alt-Tab 的图标
    }

    let ipc_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_url(&url)
        .with_ipc_handler(move |req| {
            let body = req.body().to_string();
            let action = match body.as_str() {
                "minimize" => Some(Action::Minimize),
                "tray" => Some(Action::ToTray),
                "restore" => Some(Action::Restore),
                // 页面可以在后端要求时把窗口叫回来(收进托盘后双击图标那条路)
                "show" => Some(Action::ShowWindow),
                "toggle-maximize" => Some(Action::ToggleMaximize),
                "close" => Some(Action::Close),
                "drag" => Some(Action::Drag),
                _ => None,
            };
            if let Some(a) = action {
                let _ = ipc_proxy.send_event(a);
            }
        })
        .build(&window)?;

    // 托盘常驻(启动就建)。用的是 desktop/src/tray.rs 里自己写的那套:
    // 每一步都检查返回值, 失败会写 stderr, 不再"静默失败"。
    let has_tray = tray::create(icon_path.as_deref(), proxy.clone(), window.hwnd());
    // 收成小条前的位置和大小, 恢复时用
    let mut saved_bounds: Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> = None;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Action::Minimize) => window.set_minimized(true),
            Event::UserEvent(Action::ToTray) => {
                // 收进右下角托盘: 窗口隐藏(任务栏上也不留), 同时亮出托盘图标
                if has_tray {
                    // 两个机制一起用, 确保任务栏那一格立刻消失、并且不会再自己回来:
                    //   1) ITaskbarList::DeleteTab —— 立刻抹掉任务栏按钮(tao 的实现)
                    //   2) 改扩展样式(去 APPWINDOW 加 TOOLWINDOW) —— 防止窗口一显示又回来
                    let _ = window.set_skip_taskbar(true);
                    set_taskbar_visible(window.hwnd(), false);
                    window.set_visible(false);
                } else {
                    // 托盘建不出来的兜底: 退化成普通最小化, 至少还能从任务栏点回来
                    window.set_minimized(true);
                }
            }
            Event::UserEvent(Action::ShowWindow) => {
                set_taskbar_visible(window.hwnd(), true); // 回到任务栏
                let _ = window.set_skip_taskbar(false);
                window.set_visible(true);
                window.set_focus();
            }
            Event::UserEvent(Action::Restore) => {
                let _ = window.set_always_on_top(false);
                window.set_min_inner_size(Some(LogicalSize::new(680.0, 520.0)));
                let _ = window.set_resizable(true);
                set_taskbar_visible(window.hwnd(), true);
                let _ = window.set_skip_taskbar(false);
                if let Some((position, size)) = saved_bounds.take() {
                    let _ = window.set_inner_size(LogicalSize::new(size.width as f64, size.height as f64));
                    let _ = window.set_outer_position(LogicalPosition::new(position.x, position.y));
                }
                window.set_visible(true);
                window.set_focus();
            }
            Event::UserEvent(Action::ToggleMaximize) => {
                window.set_maximized(!window.is_maximized());
            }
            Event::UserEvent(Action::Drag) => {
                let _ = window.drag_window();
            }
            Event::UserEvent(Action::Close) => *control_flow = ControlFlow::Exit,
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            _ => {
                let _ = &webview; // 保持 webview 存活
            }
        }
    });
}
