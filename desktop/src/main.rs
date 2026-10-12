//! 语音包切换器的原生外壳(无边框窗口 + WebView2)。
//!
//! 为什么需要它: 用浏览器 `--app=` 开窗口时, 那条标题栏是浏览器自己画的, 外部改不掉;
//! 这里用 tao 建一个**无边框**窗口, 再让页面自己画标题栏(见 web/ 里的 .app-titlebar)。
//! 页面上的最小化/最大化/关闭/拖动 通过 wry 的 IPC 传回来执行。
//!
//! 用法: voice-shell.exe [url]   默认 http://127.0.0.1:43110/

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Window, WindowBuilder};
use wry::WebViewBuilder;

#[derive(Debug, Clone)]
enum Action {
    Minimize,
    ToggleMaximize,
    Close,
    Drag,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:43110/".to_string());

    let event_loop = EventLoopBuilder::<Action>::with_user_event().build();
    let proxy: EventLoopProxy<Action> = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("语音包切换器")
        .with_decorations(false)          // 关键: 不要系统标题栏
        .with_resizable(true)
        .with_inner_size(LogicalSize::new(900.0, 820.0))
        .with_min_inner_size(LogicalSize::new(680.0, 520.0))
        .build(&event_loop)?;

    let webview = WebViewBuilder::new()
        .with_url(&url)
        .with_ipc_handler(move |req| {
            let body = req.body().to_string();
            let action = match body.as_str() {
                "minimize" => Some(Action::Minimize),
                "toggle-maximize" => Some(Action::ToggleMaximize),
                "close" => Some(Action::Close),
                "drag" => Some(Action::Drag),
                _ => None,
            };
            if let Some(a) = action {
                let _ = proxy.send_event(a);
            }
        })
        .build(&window)?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Action::Minimize) => window.set_minimized(true),
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
                // 保持 webview 存活
                let _ = &webview;
            }
        }
    });
}
