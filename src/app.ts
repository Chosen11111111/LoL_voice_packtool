/**
 * 应用模式: 启动后端 + 以"应用窗口"方式打开界面(不带地址栏的独立窗口, 观感同原生程序),
 * 窗口关闭后自动停掉服务并退出。
 *
 * 用法: node src/app.ts [--port 43110] [--host 127.0.0.1] [--no-window]
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appRoot, loadConfig, saveConfig } from "./core/config.ts";
import { createLogger, setLogFile, setLogLevel, type LogLevel } from "./core/logger.ts";
import { startApiServer } from "./server/api.ts";

const logger = createLogger("app");

/**
 * 退出 = 还原(用户要求: 关掉软件就相当于点了"恢复原版")。
 *
 * 只清理**选人语音**这套实时功能, 不动已经写进游戏目录的补丁文件:
 *   1. 停掉 LCU 监听
 *   2. 把客户端"播放选择语音/播放禁用语音"两栏还原成开启(选人期间才由工具静音)
 *   3. 清掉 ui.lastApplied —— 下次打开显示"未开启", 也不会自己开起来
 */
async function cleanupOnExit(): Promise<void> {
  try {
    const { setClientOriginalVoice } = await import("./modules/clientVoice.ts");
    await setClientOriginalVoice(false, "tool");
  } catch (error) {
    logger.warn(`退出清理: 还原客户端原版台词失败(${String((error as Error).message ?? error)})`);
  }
  try {
    const config = await loadConfig();
    if (config.ui?.lastApplied) {
      await saveConfig({ ...config, ui: { ...config.ui, lastApplied: null } });
      logger.info("退出清理: 已清空『上次开启』记录");
    }
  } catch (error) {
    logger.warn(`退出清理: 清空记录失败(${String((error as Error).message ?? error)})`);
  }
}

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (raw === `--${name}`) return argv[i + 1] ?? "";
    if (raw.startsWith(`--${name}=`)) return raw.slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  const argv = process.argv.slice(2);
  return argv.includes(`--${name}`) || argv.some((item) => item.startsWith(`--${name}=`));
}

/** 找一个 Chromium 内核浏览器(用来开应用窗口)。 */
function findChromium(): string | null {
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] ?? "";
  const candidates = [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    local ? path.join(local, "Google", "Chrome", "Application", "chrome.exe") : ""
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 系统默认浏览器打开(找不到 Chromium 时的兜底)。 */
function openDefaultBrowser(url: string): void {
  try {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* ignore */
  }
}

/** 以应用窗口方式打开界面, 返回窗口进程(关闭时 resolve)。 */
function openAppWindow(browser: string, url: string): ChildProcess {
  // 独立 profile: 避免复用已打开的浏览器实例(那样窗口会立刻交出去, 拿不到关闭事件)
  const profile = path.join(appRoot(), ".app-profile");
  fs.mkdirSync(profile, { recursive: true });
  return spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // CalculateNativeWinOcclusion 会让被遮挡的窗口停止渲染; 其余 sidebar/smartscreen 是 Edge 的干扰项
      "--disable-features=msEdgeSidebarV2,msSmartScreenProtection,CalculateNativeWinOcclusion",
      "--window-size=800,600",
      // 选人台词是由后端事件触发播放的, 不能受浏览器"需要用户手势才能播放"的策略限制
      "--autoplay-policy=no-user-gesture-required",
      // ---- 关键: 选人时本窗口会被客户端盖在后面, 而 Chromium 会节流/冻结被遮挡的窗口,
      // 导致 SSE 事件延迟几十秒才分发(实测有 31 秒才出声、甚至整场都没出声)。
      // 下面这几项关闭节流, 保证事件到手即播。
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-media-suspend",
      "--disable-ipc-flooding-protection"
    ],
    { stdio: "ignore", windowsHide: false }
  );
}

/**
 * 原生外壳(desktop/, Rust + WebView2): 无边框窗口, 那条系统标题栏根本不存在,
 * 标题栏由页面自己画。编译产物在 desktop/target/release/voice-shell.exe,
 * 没有就回退到浏览器 --app 模式(功能一样, 只是多一条浏览器的标题栏)。
 */
function findShell(): string | null {
  if (process.platform !== "win32") return null;
  // 发布包把外壳放在 desktop/voice-shell.exe; 开发目录里是 cargo 的产物
  const candidates = [
    path.join(appRoot(), "desktop", "voice-shell.exe"),
    path.join(appRoot(), "desktop", "target", "release", "voice-shell.exe")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * 以原生外壳打开界面(关掉窗口 = 退出程序, 和浏览器模式一致)。
 * 第二个参数是图标路径: 图标在 assets/ico/ 下由使用者提供, 外壳自己解不出来。
 */
function openShellWindow(shell: string, url: string): ChildProcess {
  // 托盘/任务栏图标: 优先用使用者设计的 .ico(系统原生加载最稳), 没有就退回 PNG
  const ico = path.join(appRoot(), "assets", "ico", "voicepack.ico");
  const png = path.join(appRoot(), "assets", "ico", "voicepack-icon-512.png");
  const icon = fs.existsSync(ico) ? ico : png;
  // 第三个参数是窗口/任务栏图标用的 PNG(ico 只有托盘能直接用)
  const args = fs.existsSync(icon) ? [url, icon, ...(fs.existsSync(png) ? [png] : [])] : [url];
  const child = spawn(shell, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: false });
  // 外壳的报错(比如托盘图标注册失败)记进日志 —— 以前直接被丢掉, 排障时看不到
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) logger.warn("[外壳] " + line.trim());
    }
  });
  return child;
}

async function waitForever(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function main(): Promise<void> {
  const config = await loadConfig();
  if (hasFlag("debug")) setLogLevel("debug" as LogLevel);

  const host = argValue("host") ?? config.server.host;
  const port = Number(argValue("port") ?? config.server.port) || config.server.port;
  const hideWindow = hasFlag("no-window");

  // 发布模式(发布包的 start.cmd 会设置这个变量): 不写日志文件, 只留 warning 以上。
  // 开发时照旧落盘 .tmp/app.log, 便于排查轮询/事件细节。
  const releaseMode = hasFlag("release") || process.env.LEAGUE_VOICE_RELEASE === "1";
  if (releaseMode) {
    setLogLevel("warn" as LogLevel);
  } else {
    // 应用模式下把日志落盘, 排障时可直接查看(窗口是独立进程, 控制台输出容易丢)
    setLogFile(path.join(appRoot(), ".tmp", "app.log"));
  }

  let running;
  try {
    running = (await startApiServer({ host, port })).running;
  } catch (error) {
    const message = String((error as Error).message ?? error);
    if (/EADDRINUSE/i.test(message)) {
      console.error(`[!] 端口 ${port} 已被占用：可能已经有一个本工具在运行。`);
      console.error(`    直接打开 http://${host}:${port}/ ，或换端口：start.cmd --port 43111`);
    } else {
      console.error(`[!] 启动失败: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${running.port}/`;
  console.log("======================================================");
  console.log("   英雄联盟 语音包 / 语言包 切换器");
  console.log("======================================================");
  console.log(`   服务地址: ${url}`);
  console.log("   界面已独立成窗口打开；关闭那个窗口即可退出。");
  console.log("======================================================");

  if (hideWindow) {
    await waitForever();
    await cleanupOnExit();
    await running.close();
    return;
  }

  // 优先用原生外壳(无边框窗口); 加 --browser-window 可强制用浏览器
  const shell = hasFlag("browser-window") ? null : findShell();
  const browser = shell ? null : findChromium();
  if (!shell && !browser) {
    console.log("[!] 未找到 Edge/Chrome，改用系统默认浏览器打开；关闭本窗口即退出。");
    openDefaultBrowser(url);
    await waitForever();
    await cleanupOnExit();
    await running.close();
    return;
  }

  let windowProcess: ChildProcess;
  try {
    windowProcess = shell ? openShellWindow(shell, url) : openAppWindow(browser!, url);
  } catch (error) {
    logger.warn(`打开应用窗口失败, 改用默认浏览器: ${String((error as Error).message ?? error)}`);
    openDefaultBrowser(url);
    await waitForever();
    await cleanupOnExit();
    await running.close();
    return;
  }

  await new Promise<void>((resolve) => {
    const finish = (reason: string) => {
      logger.info(`窗口已关闭(${reason})，正在停止服务…`);
      resolve();
    };
    windowProcess.on("exit", () => finish("window-closed"));
    windowProcess.on("error", (error) => {
      logger.warn(`窗口进程异常: ${error.message}`);
      finish("error");
    });
    process.on("SIGINT", () => {
      try {
        windowProcess.kill();
      } catch {
        /* ignore */
      }
      finish("sigint");
    });
  });

  await cleanupOnExit();
  await running.close();
  console.log("[*] 已退出。");
}

await main();
