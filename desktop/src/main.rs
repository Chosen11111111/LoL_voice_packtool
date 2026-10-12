//! 语音包切换器的原生外壳(无边框窗口 + WebView2)。
//!
//! 为什么需要它: 浏览器 `--app=` 那条标题栏是浏览器自己画的, 外部改不掉;
//! 这里用 tao 建**无边框**窗口, 标题栏由页面自己画(web/ 里的 .app-titlebar)。
//! 页面上的按键通过 wry 的 IPC 传回来执行: 最小化 / 收进右下角托盘 / 关闭 / 拖动。
//!
//! 用法: voice-shell.exe [url]   默认 http://127.0.0.1:43110/
//! 窗口默认 800x600(与原来浏览器窗口一致), 可拖边缘缩放。

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::WindowExtWindows;
use tao::window::{Icon, WindowBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
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
fn create_tray(icon_path: Option<&str>) -> Option<TrayIcon> {
    let icon = match icon_path {
        Some(path) => tray_icon::Icon::from_path(path, Some((32, 32))).ok()?,
        None => return None,
    };
    let menu = Menu::new();
    let show = MenuItem::with_id("show", "显示窗口", true, None);
    let quit = MenuItem::with_id("quit", "退出", true, None);
    menu.append_items(&[&show, &PredefinedMenuItem::separator(), &quit]).ok()?;
    TrayIconBuilder::new()
        .with_icon(icon)
        .with_tooltip("英雄联盟 语音包切换器")
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        // 固定 GUID: 用户把图标拖出折叠区后, Windows 会记住这个选择
        .with_guid(0x6c6f6c73_6b69_6e73_0001_000000000001)
        .build()
        .ok()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_else(|| "http://127.0.0.1:43110/".to_string());
    // 第二个参数(可选): 图标 PNG 的路径, 由 app.ts 传进来
    let icon_path: Option<String> = args.next();

    let event_loop = EventLoopBuilder::<Action>::with_user_event().build();
    let proxy: EventLoopProxy<Action> = event_loop.create_proxy();

    // 托盘点击: 左键单击唤回窗口; 右键菜单里的项由 MenuEvent 处理
    let tray_proxy = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let _ = tray_proxy.send_event(Action::ShowWindow);
        }
    }));
    let menu_proxy = proxy.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        match event.id().0.as_str() {
            "show" => {
                let _ = menu_proxy.send_event(Action::ShowWindow);
            }
            "quit" => {
                let _ = menu_proxy.send_event(Action::Close);
            }
            _ => {}
        }
    }));

    let window = WindowBuilder::new()
        .with_title("英雄联盟 语音包切换器")
        .with_decorations(false) // 关键: 不要系统标题栏
        .with_resizable(true)
        .with_inner_size(LogicalSize::new(800.0, 600.0))
        .with_min_inner_size(LogicalSize::new(680.0, 520.0))
        .build(&event_loop)?;
    if let Some(icon) = icon_path.as_deref().and_then(load_window_icon) {
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

    // 托盘常驻(启动就建): 这样"收进托盘"永远不会出现"窗口藏了但没有图标"的死局
    let tray: Option<TrayIcon> = create_tray(icon_path.as_deref());
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Action::Minimize) => window.set_minimized(true),
            Event::UserEvent(Action::ToTray) => {
                // 收进右下角托盘: 窗口隐藏(任务栏上也不留), 同时亮出托盘图标
                if tray.is_some() {
                    // 真正从任务栏移除按钮(不是 tao 那种临时的 DeleteTab)
                    set_taskbar_visible(window.hwnd(), false);
                    window.set_visible(false);
                } else {
                    // 托盘建不出来的兜底: 退化成普通最小化, 至少还能从任务栏点回来
                    window.set_minimized(true);
                }
            }
            Event::UserEvent(Action::ShowWindow) => {
                set_taskbar_visible(window.hwnd(), true); // 回到任务栏
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
