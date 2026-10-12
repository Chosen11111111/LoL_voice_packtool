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

/// 生成图标: 圆角蓝色方块 + 白色 L(与界面主色一致, 不依赖任何图片文件)。
fn make_icon_rgba(size: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let s = size as f32;
    let radius = s * 0.22;
    for y in 0..size {
        for x in 0..size {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            // 圆角矩形判定: 点到"内核矩形"的距离 <= 圆角半径
            let cx = fx.clamp(radius, s - radius);
            let cy = fy.clamp(radius, s - radius);
            let (dx, dy) = (fx - cx, fy - cy);
            let inside = dx * dx + dy * dy <= radius * radius;
            let i = ((y * size + x) * 4) as usize;
            if !inside {
                continue; // 透明
            }
            // 白色 L: 竖条 + 底横条
            let is_l = (fx > s * 0.30 && fx < s * 0.43 && fy > s * 0.26 && fy < s * 0.72)
                || (fy > s * 0.59 && fy < s * 0.72 && fx >= s * 0.30 && fx < s * 0.70);
            if is_l {
                rgba[i] = 255;
                rgba[i + 1] = 255;
                rgba[i + 2] = 255;
                rgba[i + 3] = 255;
            } else {
                rgba[i] = 37;
                rgba[i + 1] = 99;
                rgba[i + 2] = 235;
                rgba[i + 3] = 255;
            }
        }
    }
    rgba
}

/// 建托盘图标(收进右下角时才有; 显示窗口后会被丢弃, 图标随之消失)。
fn create_tray() -> Option<TrayIcon> {
    let icon = tray_icon::Icon::from_rgba(make_icon_rgba(32), 32, 32).ok()?;
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
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:43110/".to_string());

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
    if let Ok(icon) = Icon::from_rgba(make_icon_rgba(64), 64, 64) {
        window.set_window_icon(Some(icon)); // 任务栏/Alt-Tab 的图标
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
    let tray: Option<TrayIcon> = create_tray();
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
