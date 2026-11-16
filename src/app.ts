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
import { createLogger, getLogFile, setLogFile, setLogLevel, type LogLevel } from "./core/logger.ts";
import { run, runPowerShell } from "./core/win/shell.ts";
import { startApiServer } from "./server/api.ts";

const logger = createLogger("app");

/**
 * 退出清理: 关掉软件 = 关掉两个"客户端内"功能, 并重启客户端让它生效。
 *
 *   1. 对局前选人语音: 关插件开关 + 拆掉语音资源挂载;
 *   2. 客户端界面文字: 移除文字插件与语言标记;
 *   3. 两个都不用加载器时, 撤掉注册表激活项;
 *   4. 以上有任何改动且客户端在运行 -> 重启一次客户端;
 *   5. 清掉 ui.lastApplied —— 下次打开显示"未开启", 也不会自己开起来。
 *
 * **局内语音 / 局内文字是写进游戏目录的补丁文件, 这里绝不动**:
 * 那是用户这次"开启语音包"的结果, 要还原请点界面上的『恢复原版』。
 */

/**
 * 启动自检: 如果注册表里还挂着加载器激活项, 但当前两个功能都没开, 就把它撤掉。
 * 外服用户的典型症状是"客户端打不开, 只剩一个修复按钮"—— 根因就是这条激活项没撤干净。
 */
async function healStaleLoader(reason: string): Promise<void> {
  try {
    const [{ rollbackLoaderIfIdle }, { lobbyVoiceEnabled }] = await Promise.all([
      import("./textpack/deploy.ts"),
      import("./modules/lobbyVoice.ts")
    ]);
    const result = await rollbackLoaderIfIdle(reason, () => lobbyVoiceEnabled());
    if (result.rolledBack) logger.warn(result.message);
    else logger.info(`加载器检查(${reason}): ${result.message}`);
  } catch (error) {
    logger.warn(`加载器检查失败(${reason}): ${String((error as Error).message ?? error)}`);
  }
}

async function cleanupOnExit(): Promise<void> {
  // 只关"客户端内"的两个功能(选人语音 / 客户端界面文字), 局内补丁一律不动。
  try {
    const { shutDownClientFeatures } = await import("./modules/shutdown.ts");
    const result = await shutDownClientFeatures("退出清理");
    for (const note of result.notes) logger.info(`退出清理: ${note}`);
    if (!result.changed) logger.info("退出清理: 选人语音与客户端界面文字都未开启，无需处理");
  } catch (error) {
    logger.warn(`退出清理: 关闭选人语音/客户端界面文字失败(${String((error as Error).message ?? error)})`);
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
  // 独立 profile: 避免复用已打开的浏览器实例(那样窗口会立刻交出去, 拿不到关闭事件)。
  // 放 LOCALAPPDATA 而不是程序目录: 程序目录可能只读, 而且不该往发布包里写缓存。
  const profile = path.join(process.env["LOCALAPPDATA"] ?? appRoot(), "LoL_Voice", ".app-profile");
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
/**
 * 本机有没有 WebView2 运行时。
 *
 * 原生外壳是 wry/WebView2 做的: 系统里没有运行时, voice-shell.exe 会**秒退**,
 * 用户看到的就是"双击闪一下就没了"。Win10 LTSC / 精简版 / 部分 N 版都没有预装。
 */
function hasWebView2(): boolean {
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  for (const root of [path.join(pf86, "Microsoft", "EdgeWebView", "Application"), path.join(pf, "Microsoft", "EdgeWebView", "Application")]) {
    try {
      for (const dir of fs.readdirSync(root)) {
        if (fs.existsSync(path.join(root, dir, "msedgewebview2.exe"))) return true;
      }
    } catch {
      /* 这个位置没装, 继续 */
    }
  }
  return false;
}

/**
 * 清理上一次留下的窗口外壳。
 *
 * 外壳(voice-shell.exe)会把 WebView2 的用户数据目录固定在 %LOCALAPPDATA%\LoL_Voice\WebView2。
 * 如果上一次的 shell 没退干净(闪退/托盘收起后异常), 新 shell 打开这个目录会报
 * 0x800700AA「请求的资源在使用中」→ 秒退 → 用户看不到界面。
 * 名字是我们独有的, taskkill 不会误伤别的程序。
 */
async function killStaleShells(): Promise<void> {
  try {
    await run("taskkill", ["/F", "/IM", "voice-shell.exe"], { timeoutMs: 8000 });
  } catch {
    /* 没有就算了 */
  }
}

/** 结束占着 WebView2 用户目录的孤儿进程(只匹配我们自己的路径)。 */
async function killOrphanWebView2(): Promise<void> {
  try {
    await runPowerShell(
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*LoL_Voice*WebView2*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      { timeoutMs: 15000 }
    );
  } catch {
    /* 查不到就算了 */
  }
}

/** 外壳使用的 WebView2 用户数据目录(与 desktop/src/main.rs 里一致)。 */
function webviewDataDir(): string {
  return path.join(process.env["LOCALAPPDATA"] ?? appRoot(), "LoL_Voice", "WebView2");
}

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
    // 发布包也留一份日志: 用户报"闪退"时, 这份文件就是唯一的线索。
    // 先试 %LOCALAPPDATA%; 不行(只读/被占用/被安全软件拦)就退到软件目录自己的 .tmp,
    // 再不行就只输出控制台 —— 绝不能因为日志写不进去而让程序启动失败。
    const candidates = [
      path.join(process.env["LOCALAPPDATA"] ?? appRoot(), "LoL_Voice", "app.log"),
      path.join(appRoot(), ".tmp", "app.log")
    ];
    for (const file of candidates) {
      setLogFile(file);
      if (getLogFile()) break;
    }
  } else {
    // 应用模式下把日志落盘, 排障时可直接查看(窗口是独立进程, 控制台输出容易丢)
    setLogFile(path.join(appRoot(), ".tmp", "app.log"));
  }

  // 安装目录不可写(最常见的坑: 解压到 C:\Program Files)会让配置、语音包、日志全部写不进去,
  // 用户看到的就是"点了没反应"或者启动直接失败。这里启动时先探一次, 早发现早提示。
  try {
    const probe = path.join(appRoot(), ".write-probe");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (error) {
    const hint = "安装目录不可写（可能放进了 C:\\Program Files）。请把整个文件夹移到 D 盘或桌面再运行。";
    logger.error(hint + " 具体错误: " + String((error as Error).message ?? error));
    console.error("[!] " + hint);
  }

  await healStaleLoader("启动自检");

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
  // 没有 WebView2 就别用原生外壳了: 它必然秒退, 表现为"打开了但界面不出现"
  const webview2 = hasWebView2();
  if (!webview2) logger.warn("未检测到 WebView2 运行时, 改用浏览器窗口(装 WebView2 后可恢复无边框窗口)");
  const shell = hasFlag("browser-window") || !webview2 ? null : findShell();
  const browser = shell ? null : findChromium();
  if (!shell && !browser) {
    console.log("[!] 未找到 Edge/Chrome，改用系统默认浏览器打开；关闭本窗口即退出。");
    openDefaultBrowser(url);
    await waitForever();
    await cleanupOnExit();
    await running.close();
    return;
  }

  // 上一次的 shell 可能还占着 WebView2 的用户数据目录(0x800700AA)。先清掉再开。
  if (shell) {
    await killStaleShells();
    await new Promise((resolve) => setTimeout(resolve, 200));
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

  /** 等窗口进程结束; 外壳在 4 秒内就退出时判定为"启动失败"而不是"用户关窗"。 */
  const waitWindow = (proc: ChildProcess, isShell: boolean): Promise<"closed" | "failed"> =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      proc.on("exit", (code) => {
        if (isShell && Date.now() - startedAt < 4000) {
          logger.warn(`原生外壳 ${Date.now() - startedAt}ms 就退出了(exit=${code}), 判定为启动失败`);
          resolve("failed");
          return;
        }
        logger.info(`窗口已关闭(exit=${code})，正在停止服务…`);
        resolve("closed");
      });
      proc.on("error", (error) => {
        logger.warn(`窗口进程异常: ${error.message}`);
        resolve(isShell ? "failed" : "closed");
      });
    });

  const stopOnSignal = () => {
    try {
      windowProcess.kill();
    } catch {
      /* ignore */
    }
  };
  process.on("SIGINT", stopOnSignal);

  let outcome = await waitWindow(windowProcess, Boolean(shell));
  if (outcome === "failed" && shell) {
    // 最常见的原因: 上一次的 msedgewebview2 还占着用户数据目录(0x800700AA)。
    // 清掉孤儿进程后重试一次, 比直接退回浏览器窗口更接近用户想要的界面。
    logger.warn("原生外壳启动失败, 清理残留的 WebView2 进程后重试一次…");
    await killStaleShells();
    await killOrphanWebView2();
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      windowProcess = openShellWindow(shell, url);
      outcome = await waitWindow(windowProcess, true);
    } catch (error) {
      logger.warn(`重试原生外壳失败: ${String((error as Error).message ?? error)}`);
    }
    if (outcome === "failed") {
      // 用户数据目录本身坏了(更新中断/被杀软改过)也会一直 BUSY: 清掉缓存目录再试最后一次。
      logger.warn("清掉 WebView2 用户数据缓存后最后重试一次…");
      await killStaleShells();
      await killOrphanWebView2();
      await fs.promises.rm(webviewDataDir(), { recursive: true, force: true }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        windowProcess = openShellWindow(shell, url);
        outcome = await waitWindow(windowProcess, true);
      } catch (error) {
        logger.warn(`最后一次重试原生外壳失败: ${String((error as Error).message ?? error)}`);
      }
    }
  }
  if (outcome === "failed") {
    // 外壳死了(最常见是 WebView2 缺失/被杀软拦截/显卡驱动崩), 退回浏览器窗口,
    // 至少让用户看到界面, 而不是"闪一下就没了"。
    const fallbackBrowser = findChromium();
    logger.warn("原生外壳启动失败, 改用浏览器窗口继续运行");
    if (fallbackBrowser) {
      try {
        windowProcess = openAppWindow(fallbackBrowser, url);
        outcome = await waitWindow(windowProcess, false);
      } catch (error) {
        logger.warn(`浏览器窗口也打不开: ${String((error as Error).message ?? error)}`);
        openDefaultBrowser(url);
        await waitForever();
        outcome = "closed";
      }
    } else {
      openDefaultBrowser(url);
      await waitForever();
      outcome = "closed";
    }
  }
  process.off("SIGINT", stopOnSignal);

  await cleanupOnExit();
  await running.close();
  console.log("[*] 已退出。");
}

process.on("uncaughtException", (error) => {
  logger.error(`未捕获异常, 即将退出: ${error?.stack ?? String(error)}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? reason.stack : String(reason);
  logger.error(`未处理的 Promise 拒绝, 即将退出: ${detail}`);
  process.exit(1);
});

await main();
