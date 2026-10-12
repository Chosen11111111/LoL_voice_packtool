/**
 * 生成发布包: release/  —— 给最终用户的免安装版本。
 *
 * 用户的电脑上不需要任何环境: 自带一份 Node 运行时(runtime/node.exe),
 * 双击 start.cmd 就能用。发布模式下日志只留 warning 以上, 也不写日志文件。
 *
 * 用法:
 *   node scripts/release.ts          生成 release/(默认不压缩)
 *   node scripts/release.ts --zip    额外压一个 release.zip
 *
 * 刻意不打包的东西(用户用不到, 只会占地方):
 *   tests/  docs/  scripts/  .tmp/  .git/  desktop/src  desktop/target
 *   tsconfig.json  config.json(用户自己的配置)  language/(用户自己的语音包)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "release");
const wantZip = process.argv.includes("--zip"); // 默认不压缩

/** 复制目录(不存在就跳过)。 */
async function copyDir(from: string, to: string, filter?: (name: string) => boolean) {
  if (!(await exists(from))) return 0;
  await fs.cp(from, to, { recursive: true, filter: filter ? (src) => filter(path.basename(src)) : undefined });
  return 1;
}

async function exists(target: string) {
  return fs.stat(target).then(() => true).catch(() => false);
}

/** 递归统计大小与文件数。 */
async function measure(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else {
        bytes += (await fs.stat(target)).size;
        files += 1;
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + " MB";

// 1) 清空输出目录
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
console.log("输出目录: " + out);

// 2) 程序本体
await copyDir(path.join(root, "src"), path.join(out, "src"));
await copyDir(path.join(root, "web"), path.join(out, "web"));
await copyDir(path.join(root, "assets"), path.join(out, "assets"));

// 3) 窗口外壳(只带编译好的 exe, 不带 Rust 源码与 target)
await fs.mkdir(path.join(out, "desktop"), { recursive: true });
const shell = path.join(root, "desktop", "target", "release", "voice-shell.exe");
if (await exists(shell)) {
  await fs.copyFile(shell, path.join(out, "desktop", "voice-shell.exe"));
  console.log("外壳: voice-shell.exe " + mb((await fs.stat(shell)).size));
} else {
  console.log("[!] 没找到 voice-shell.exe, 发布包会退回浏览器窗口模式");
}

// 4) 自带 Node 运行时(免安装的关键)
await fs.mkdir(path.join(out, "runtime"), { recursive: true });
const nodeExe = process.execPath;
await fs.copyFile(nodeExe, path.join(out, "runtime", "node.exe"));
console.log("运行时: node.exe " + mb((await fs.stat(nodeExe)).size) + " (来自 " + nodeExe + ")");

// 5) 启动脚本(纯 ASCII + CRLF)
const startCmd = [
  "@echo off",
  "rem League Voice - voice pack switcher (portable, no install needed)",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  "title League Voice",
  "rem \u53d1\u5e03\u6a21\u5f0f: \u65e5\u5fd7\u53ea\u7559 warning \u4ee5\u4e0a, \u4e5f\u4e0d\u5199\u65e5\u5fd7\u6587\u4ef6",
  'set "LEAGUE_VOICE_RELEASE=1"',
  '"%CD%\\runtime\\node.exe" "%CD%\\src\\app.ts" %*',
  "if errorlevel 1 pause"
].join("\r\n") + "\r\n";
await fs.writeFile(path.join(out, "start.cmd"), startCmd, "ascii");

// 6) 给用户的说明
const readme = [
  "\u82f1\u96c4\u8054\u76df \u8bed\u97f3\u5305\u5207\u6362\u5668 \u2014\u2014 \u514d\u5b89\u88c5\u7248",
  "",
  "\u600e\u4e48\u7528",
  "  \u53cc\u51fb start.cmd \u5373\u53ef\u3002\u4e0d\u9700\u8981\u5b89\u88c5\u4efb\u4f55\u4e1c\u897f(Node \u8fd0\u884c\u65f6\u5df2\u7ecf\u6253\u5305\u5728\u91cc\u9762)\u3002",
  "",
  "\u7b2c\u4e00\u6b21\u4f7f\u7528",
  "  1. \u786e\u8ba4\u754c\u9762\u4e0a\u7684\u201c\u6e38\u620f\u8def\u5f84\u201d(\u4e00\u822c\u4f1a\u81ea\u52a8\u627e\u5230; \u627e\u4e0d\u5230\u5c31\u70b9\u81ea\u52a8\u641c\u7d22\u6216\u624b\u586b)",
  "  2. \u5148\u70b9\u201c\u4e0b\u8f7d\u8bed\u97f3\u5305\u201d\u62ff\u5230\u8bed\u97f3\u5305, \u5728\u4e0b\u62c9\u680f\u91cc\u9009\u4e2d",
  "  3. \u70b9\u201c\u5f00\u542f\u8bed\u97f3\u5305\u201d",
  "",
  "\u6ce8\u610f",
  "  \u5f00\u542f\u540e\u8bf7\u52ff\u901a\u8fc7 WeGame \u542f\u52a8, \u76f4\u63a5\u542f\u52a8\u82f1\u96c4\u8054\u76df\u5ba2\u6237\u7aef",
  "  \u60f3\u7528\u5bf9\u5c40\u9009\u4eba\u8bed\u97f3, \u5f00\u7740\u672c\u8f6f\u4ef6\u5c31\u884c",
  "  \u4e0d\u60f3\u7528\u4e86, \u70b9\u201c\u8fd8\u539f\u201d\u5373\u53ef",
  "",
  "\u6587\u4ef6\u8bf4\u660e",
  "  src\\      \u7a0b\u5e8f\u672c\u4f53",
  "  web\\      \u754c\u9762",
  "  runtime\\  \u81ea\u5e26\u7684 Node \u8fd0\u884c\u65f6(\u4e0d\u8981\u5220)",
  "  desktop\\  \u7a97\u53e3\u5916\u58f3",
  "  assets\\   \u56fe\u6807\u7b49\u7d20\u6750",
  "  language\\ \u8bed\u97f3\u5305\u653e\u8fd9\u91cc(\u9996\u6b21\u8fd0\u884c\u4f1a\u81ea\u52a8\u521b\u5efa)",
  "",
  "\u5378\u8f7d: \u76f4\u63a5\u5220\u6389\u6574\u4e2a\u6587\u4ef6\u5939\u5373\u53ef\u3002\u914d\u7f6e\u5728 config.json\u3002"
].join("\r\n") + "\r\n";
await fs.writeFile(path.join(out, "README.txt"), readme, "utf8");

// 7) 统计 + 打包
const size = await measure(out);
console.log("\n发布包: " + size.files + " 个文件, " + mb(size.bytes));
if (wantZip) {
  const zip = path.join(root, "release.zip");
  await fs.rm(zip, { force: true });
  const result = spawnSync("tar", ["-a", "-c", "-f", zip, "-C", out, "."], { stdio: "ignore" });
  if (result.status === 0 && (await exists(zip))) {
    console.log("压缩包: release.zip " + mb((await fs.stat(zip)).size));
  } else {
    console.log("[!] 压缩失败(可以用系统自带的右键压缩), 文件夹本身已经可用");
  }
}
