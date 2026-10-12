//! 托盘图标: 直接调用系统接口实现, 不用第三方库。
//!
//! 为什么要自己写: 之前用的 tray-icon 在注册失败时**不报错**(源码里就一句注释然后继续),
//! 结果就是"看起来一切正常、图标却永远不出现", 完全没法排查。
//! 这里每一步都检查返回值, 失败就写 stderr, 并且按 Windows 的惯例重试 / 响应 TaskbarCreated。

use crate::Action;
use std::sync::Mutex;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use tao::event_loop::EventLoopProxy;

/// 托盘回调消息(WM_APP + 1)。
const WM_TRAY: u32 = 0x8000 + 1;
/// 我们自己的图标 id, 随便取一个不冲突的。
const TRAY_ID: u32 = 0x4C56;
const TRAY_CLASS: &str = "LoLVoiceTrayWindow";

const NIM_ADD: u32 = 0x0000_0000;
const NIM_SETVERSION: u32 = 0x0000_0004;
const NIF_MESSAGE: u32 = 0x0000_0001;
const NIF_ICON: u32 = 0x0000_0002;
const NIF_TIP: u32 = 0x0000_0004;
const NOTIFYICON_VERSION_4: u32 = 4;

const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_CONTEXTMENU: u32 = 0x007B;
const WM_COMMAND: u32 = 0x0111;
const WM_DESTROY: u32 = 0x0002;

const IMAGE_ICON: u32 = 1;
const LR_LOADFROMFILE: u32 = 0x0010;
const LR_DEFAULTSIZE: u32 = 0x0040;

const TPM_RIGHTBUTTON: u32 = 0x0002;
const TPM_RETURNCMD: u32 = 0x0100;

#[repr(C)]
#[derive(Clone, Copy)]
struct NotifyIconDataW {
    cb_size: u32,
    hwnd: isize,
    uid: u32,
    uflags: u32,
    callback_message: u32,
    hicon: isize,
    tip: [u16; 128],
    state: u32,
    state_mask: u32,
    info: [u16; 256],
    version: u32,
    info_title: [u16; 64],
    info_flags: u32,
    guid: [u8; 16],
    balloon_icon: isize,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn RegisterClassW(class: *const WndClassW) -> u16;
    fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: isize,
        menu: isize,
        instance: isize,
        param: *mut core::ffi::c_void,
    ) -> isize;
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn DestroyWindow(hwnd: isize) -> i32;
    fn LoadImageW(instance: isize, name: *const u16, kind: u32, cx: i32, cy: i32, flags: u32) -> isize;
    fn GetCursorPos(point: *mut Point) -> i32;
    fn CreatePopupMenu() -> isize;
    fn AppendMenuW(menu: isize, flags: u32, id: usize, text: *const u16) -> i32;
    fn TrackPopupMenu(menu: isize, flags: u32, x: i32, y: i32, reserved: i32, hwnd: isize, rect: isize) -> i32;
    fn DestroyMenu(menu: isize) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn RegisterWindowMessageW(name: *const u16) -> u32;
    fn GetLastError() -> u32;
    fn GetModuleHandleW(name: *const u16) -> isize;
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn Shell_NotifyIconW(message: u32, data: *mut NotifyIconDataW) -> i32;
}

#[repr(C)]
struct WndClassW {
    style: u32,
    wnd_proc: Option<unsafe extern "system" fn(isize, u32, usize, isize) -> isize>,
    cls_extra: i32,
    wnd_extra: i32,
    instance: isize,
    icon: isize,
    cursor: isize,
    background: isize,
    menu_name: *const u16,
    class_name: *const u16,
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

/// 菜单项 id
const MENU_RESTORE: usize = 1;
const MENU_QUIT: usize = 2;

/// 让窗口过程能把事件送回 tao 的事件循环。
static PROXY: Mutex<Option<EventLoopProxy<Action>>> = Mutex::new(None);
/// 图标句柄(重注册时用)
static ICON: AtomicIsize = AtomicIsize::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn window_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    unsafe {
        match msg {
            WM_TRAY => {
                // 左键单击 = 恢复窗口; 右键 = 菜单
                if lparam as u32 == WM_LBUTTONUP {
                    if let Some(proxy) = PROXY.lock().ok().and_then(|p| p.clone()) {
                        let _ = proxy.send_event(Action::Restore);
                    }
                } else if lparam as u32 == WM_RBUTTONUP || lparam as u32 == WM_CONTEXTMENU {
                    show_menu(hwnd);
                }
            }
            WM_COMMAND => {
                let id = wparam & 0xffff;
                if let Some(proxy) = PROXY.lock().ok().and_then(|p| p.clone()) {
                    if id == MENU_RESTORE {
                        let _ = proxy.send_event(Action::Restore);
                    } else if id == MENU_QUIT {
                        let _ = proxy.send_event(Action::Close);
                    }
                }
            }
            WM_DESTROY => {}
            other => {
                // Explorer 重启后会广播 TaskbarCreated, 必须重新注册, 否则图标就没了
                if TASKBAR_CREATED.load(Ordering::Relaxed) != 0 && other == TASKBAR_CREATED.load(Ordering::Relaxed) {
                    eprintln!("[voice-shell] 任务栏重启, 重新注册托盘图标");
                    let _ = add_icon(hwnd);
                }
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

unsafe fn show_menu(hwnd: isize) {
    unsafe {
        let menu = CreatePopupMenu();
        if menu == 0 {
            return;
        }
        AppendMenuW(menu, 0x0000, MENU_RESTORE, wide("恢复窗口").as_ptr());
        AppendMenuW(menu, 0x0000, MENU_QUIT, wide("关闭软件").as_ptr());
        let mut point = Point { x: 0, y: 0 };
        GetCursorPos(&mut point);
        // 不先 SetForegroundWindow 的话, 菜单点外面不会关掉
        SetForegroundWindow(hwnd);
        let chosen = TrackPopupMenu(
            menu,
            TPM_RIGHTBUTTON | TPM_RETURNCMD,
            point.x,
            point.y,
            0,
            hwnd,
            0,
        );
        DestroyMenu(menu);
        if chosen != 0 {
            if let Some(proxy) = PROXY.lock().ok().and_then(|p| p.clone()) {
                if chosen as usize == MENU_RESTORE {
                    let _ = proxy.send_event(Action::Restore);
                } else if chosen as usize == MENU_QUIT {
                    let _ = proxy.send_event(Action::Close);
                }
            }
        }
    }
}

/// 组装 NOTIFYICONDATAW(带图标与提示)。
unsafe fn build_data(hwnd: isize) -> NotifyIconDataW {
    unsafe {
        let mut data: NotifyIconDataW = std::mem::zeroed();
        data.cb_size = std::mem::size_of::<NotifyIconDataW>() as u32;
        data.hwnd = hwnd;
        data.uid = TRAY_ID;
        data.uflags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        data.callback_message = WM_TRAY;
        data.hicon = ICON.load(Ordering::Relaxed);
        let tip = wide("LoL Voice - 英雄联盟语音包切换器");
        for (i, unit) in tip.iter().take(127).enumerate() {
            data.tip[i] = *unit;
        }
        data
    }
}

unsafe fn add_icon(hwnd: isize) -> bool {
    unsafe {
        let mut data = build_data(hwnd);
        let ok = Shell_NotifyIconW(NIM_ADD, &mut data) != 0;
        if !ok {
            let code = GetLastError();
            // 5 = 拒绝访问: 常见原因是进程的完整性级别低于资源管理器(比如被别的程序以低权限拉起)
            eprintln!("[voice-shell] 托盘注册失败(NIM_ADD), 错误码 {code}{}", if code == 5 { " (拒绝访问: 进程权限级别不够)" } else { "" });
            if code == 5 {
                // 实测原因: 所在目录被打过"低完整性"标记, 里面的 exe 一律低权限运行,
                // 而 Windows 禁止低权限进程注册托盘图标。给一条可操作的指引。
                eprintln!("[voice-shell] 提示: 如果程序所在目录带低完整性标记, 运行 scripts\\fix-integrity.cmd 可修复");
            }
        } else {
            // 让系统用 v4 的回调语义
            let mut version = build_data(hwnd);
            version.version = NOTIFYICON_VERSION_4;
            let _ = Shell_NotifyIconW(NIM_SETVERSION, &mut version);
        }
        ok
    }
}

/// 建托盘图标。返回 false 表示没成功(原因已经写到 stderr)。
pub fn create(icon_path: Option<&str>, proxy: EventLoopProxy<Action>) -> bool {
    if let Ok(mut slot) = PROXY.lock() {
        *slot = Some(proxy);
    }
    unsafe {
        ICON.store(0, Ordering::Relaxed);
        if let Some(path) = icon_path {
            let handle = LoadImageW(
                0,
                wide(path).as_ptr(),
                IMAGE_ICON,
                32,
                32,
                LR_LOADFROMFILE | LR_DEFAULTSIZE,
            );
            ICON.store(handle, Ordering::Relaxed);
            if handle == 0 {
                eprintln!("[voice-shell] 读图标失败 {} (错误码 {})", path, GetLastError());
            }
        } else {
            eprintln!("[voice-shell] 没有图标路径");
        }

        TASKBAR_CREATED.store(RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()), Ordering::Relaxed);

        let instance = GetModuleHandleW(std::ptr::null());
        let class_name = wide(TRAY_CLASS);
        let class = WndClassW {
            style: 0,
            wnd_proc: Some(window_proc),
            cls_extra: 0,
            wnd_extra: 0,
            instance,
            icon: 0,
            cursor: 0,
            background: 0,
            menu_name: std::ptr::null(),
            class_name: class_name.as_ptr(),
        };
        if RegisterClassW(&class) == 0 {
            eprintln!("[voice-shell] 注册托盘窗口类失败, 错误码 {}", GetLastError());
            return false;
        }
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("LoL Voice Tray").as_ptr(),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            instance,
            std::ptr::null_mut(),
        );
        if hwnd == 0 {
            eprintln!("[voice-shell] 建托盘窗口失败, 错误码 {}", GetLastError());
            return false;
        }

        // 注册失败时重试几次: Explorer 偶尔会有还没准备好的瞬间
        for attempt in 0..5 {
            if add_icon(hwnd) {
                if attempt > 0 {
                    eprintln!("[voice-shell] 托盘注册在第 {} 次重试成功", attempt + 1);
                }
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
            if attempt == 4 {
                DestroyWindow(hwnd);
            }
        }
        false
    }
}
