/**
 * 客户端界面文字翻译 —— 部署。
 *
 * 范围: 只作用于英雄联盟**客户端**界面。客户端是客户端, 局内是局内 ——
 * 本模块装的是"C++ 注入核心 + 一个 JS 插件", 只注入客户端的两个浏览器进程
 * (LeagueClientUx / LeagueClientUxRender), 与局内游戏无关。
 *
 * 做什么:
 *   1. 把官方 core.dll(未修改) + 配置 + 选定的语言插件复制到本地目录(不需要管理员);
 *   2. 生成 install.cmd / uninstall.cmd(可读、可审计), 需要管理员时由界面触发 UAC 执行;
 *   3. 读取注册表判断是否已激活(读注册表不需要管理员)。
 *
 * 为什么发 core.dll 而不是整套 Pengu: 发行包里真正必需的只有这一个 455 KB 的文件,
 * 启动器(4 MB 的 WPF 界面)在游戏期间根本不需要运行。许可为 MIT, 原样收录并附声明。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 装到用户目录, 而不是软件目录 —— 软件可能装在只读位置。 */
export function loaderDir(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "LoL_Voice", "loader");
}

/** 软件包内的资源目录(core.dll 与字典都在这里)。 */
export function assetDir(): string {
  return path.join(import.meta.dirname, "..", "..", "assets");
}

/** 激活用的注册表位置: 把 LeagueClientUx.exe 的调试器换成 rundll32 调用 core.dll。 */
export const IFEO_KEY =
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\LeagueClientUx.exe";

/** 写进注册表的 Debugger 值。 */
export function debuggerValue(dir: string): string {
  return `rundll32 "${path.join(dir, "core.dll")}", #6000`;
}

export interface TextPackState {
  /** 可用的目标语言(来自 assets/textpack/<语言>/plugin/index.js)。 */
  supported: string[];
  /** 已装到本地的语言("" = 没装)。 */
  staged: string;
  /** 注册表激活项的状态。 */
  registry: "set" | "missing" | "unknown";
  /** 装好且已激活。 */
  active: boolean;
  dir: string;
  message: string;
}

/** 扫描随包分发的语言插件。 */
export async function supportedLocales(): Promise<string[]> {
  const base = path.join(assetDir(), "textpack");
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "plugin") continue;
      const plugin = path.join(base, entry.name, "plugin", "index.js");
      if (await fs.stat(plugin).then(() => true).catch(() => false)) found.push(entry.name);
    }
    return found.sort();
  } catch {
    return [];
  }
}

/** 读取注册表里的激活项(只读, 不需要管理员)。 */
export async function readRegistry(): Promise<"set" | "missing" | "unknown"> {
  return new Promise((resolve) => {
    const child = spawn("reg", ["query", IFEO_KEY, "/v", "Debugger"], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => resolve("unknown"));
    child.on("close", (code) => {
      if (code === 0 && /Debugger\s+REG_SZ/i.test(out)) resolve("set");
      else if (code === 1) resolve("missing");
      else resolve("unknown");
    });
  });
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true).catch(() => false);
}

export async function getState(): Promise<TextPackState> {
  const dir = loaderDir();
  const supported = await supportedLocales();
  const registry = await readRegistry();
  let staged = "";
  const marker = path.join(dir, "locale.txt");
  if (await exists(path.join(dir, "core.dll"))) {
    staged = ((await fs.readFile(marker, "utf8").catch(() => "")) || "").trim();
  }
  const active = registry === "set" && staged !== "";
  const message = active
    ? `已开启（目标语言 ${staged}）`
    : staged
      ? "已复制文件, 但还没激活（需要管理员权限写一次注册表）"
      : "未开启";
  return { supported, staged, registry, active, dir, message };
}

/** 配置文件: 关掉它会往客户端追加的那批 Chromium 开关(含 --no-sandbox), 也不要热键。 */
function configText(): string {
  return [
    "# LoL Voice 客户端文字翻译 —— 使用官方 Pengu Loader 的 core.dll(未修改)",
    "# 关掉默认开启的 optimized_client: 它会向客户端追加一批 Chromium 开关(含 --no-sandbox),",
    "# 我们只借用「把插件注入页面」这一个能力, 不需要它改动客户端的启动方式。",
    "optimized_client=false",
    "use_hotkeys=false",
    ""
  ].join("\r\n");
}

function scripts(dir: string): { install: string; uninstall: string } {
  const value = debuggerValue(dir).replace(/"/g, '\\"');
  const key = IFEO_KEY.replace(/\\\\/g, "\\");
  return {
    install: [
      "@echo off",
      "chcp 65001 >nul",
      "rem 由 LoL Voice 生成: 只写一个注册表项, 让 core.dll 能在客户端启动时注入我们的文字插件",
      `reg add "${key}" /v Debugger /t REG_SZ /d "${value}" /f`,
      "if errorlevel 1 (echo 激活失败 & exit /b 1)",
      "echo 已开启客户端文字翻译（重启客户端后生效）",
      "exit /b 0",
      ""
    ].join("\r\n"),
    uninstall: [
      "@echo off",
      "chcp 65001 >nul",
      "rem 由 LoL Voice 生成: 删除激活项, 客户端恢复原样",
      `reg delete "${key}" /v Debugger /f`,
      "echo 已关闭客户端文字翻译",
      "exit /b 0",
      ""
    ].join("\r\n")
  };
}

export interface StageResult {
  ok: boolean;
  dir: string;
  locale: string;
  message: string;
}

/** 复制文件(不需要管理员)。真正的激活要另一个提权步骤。 */
export async function stage(locale: string): Promise<StageResult> {
  const dir = loaderDir();
  const source = path.join(assetDir(), "textpack", locale, "plugin", "index.js");
  const core = path.join(assetDir(), "loader", "core.dll");
  if (!(await exists(source))) return { ok: false, dir, locale, message: `没有 ${locale} 的语言插件` };
  if (!(await exists(core))) return { ok: false, dir, locale, message: "软件包里的 core.dll 缺失" };
  try {
    await fs.mkdir(path.join(dir, "plugins", "text-replacer"), { recursive: true });
    await fs.copyFile(core, path.join(dir, "core.dll"));
    await fs.copyFile(path.join(assetDir(), "loader", "LICENSE-pengu.txt"), path.join(dir, "LICENSE-pengu.txt"));
    await fs.copyFile(path.join(assetDir(), "loader", "NOTICE.txt"), path.join(dir, "NOTICE.txt"));
    await fs.writeFile(path.join(dir, "config"), configText(), "utf8");
    await fs.writeFile(path.join(dir, "plugins", "text-replacer", "index.js"), await fs.readFile(source), "utf8");
    await fs.writeFile(path.join(dir, "locale.txt"), locale + "\n", "utf8");
    const { install, uninstall } = scripts(dir);
    await fs.writeFile(path.join(dir, "install.cmd"), install, "utf8");
    await fs.writeFile(path.join(dir, "uninstall.cmd"), uninstall, "utf8");
    return { ok: true, dir, locale, message: "文件已复制，接着需要管理员权限激活一次" };
  } catch (error) {
    return { ok: false, dir, locale, message: `复制失败: ${String((error as Error).message).slice(0, 120)}` };
  }
}

/** 只删我们自己放的文件; 目录里有别的东西就留着(绝不误删用户的文件)。 */
export async function unstage(): Promise<{ ok: boolean; message: string }> {
  const dir = loaderDir();
  try {
    await fs.rm(path.join(dir, "plugins", "text-replacer"), { recursive: true, force: true });
    for (const name of ["core.dll", "config", "locale.txt", "LICENSE-pengu.txt", "NOTICE.txt", "install.cmd", "uninstall.cmd"]) {
      await fs.rm(path.join(dir, name), { force: true });
    }
    return { ok: true, message: "已移除本地文件" };
  } catch (error) {
    return { ok: false, message: `移除失败: ${String((error as Error).message).slice(0, 120)}` };
  }
}

/** 用 UAC 执行我们生成的那个脚本(会弹一次系统授权框)。 */
export async function runElevated(script: "install" | "uninstall"): Promise<{ ok: boolean; message: string }> {
  const file = path.join(loaderDir(), script + ".cmd");
  if (!(await exists(file))) return { ok: false, message: "找不到脚本, 请先复制文件" };
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Start-Process -FilePath '${file}' -Verb RunAs -Wait`], { windowsHide: true });
    child.on("error", (error) => resolve({ ok: false, message: String(error.message).slice(0, 120) }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, message: script === "install" ? "已激活" : "已取消激活" });
      else resolve({ ok: false, message: "授权被取消或写入失败" });
    });
  });
}
