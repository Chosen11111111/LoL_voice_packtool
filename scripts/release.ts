/**
 * 生成发布包: release/LoL_Voice_<版本>/
 *
 * 用户看到的只有两样东西:
 *   LoL_Voice.exe     启动入口(双击即用, 带图标)
 *   resource\         所有东西都在这里面(自带的 Node、程序本体、界面、外壳、素材)
 *
 * 用户的电脑上不需要任何环境。刻意不打包: README、tests/ docs/ scripts/ .tmp/ .git/
 * desktop/src desktop/target tsconfig.json config.json(用户自己的配置)
 * language/(用户自己的语音包, 首次运行会在 resource\ 下自动创建)。
 *
 * 用法: node scripts/release.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 版本号: 发布就改这里(文件夹名跟着变)。 */
const VERSION = "1.01";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "release", `LoL_Voice_${VERSION}`);
/** 用户看到的那一个文件夹。 */
const resource = path.join(out, "resource");

async function exists(target: string) {
  return fs.stat(target).then(() => true).catch(() => false);
}

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

// 1) 建版本文件夹 —— 只写不删: 不动 release/ 下任何已有内容
//    (曾经这里会清空 release/, 把用户正在测试的旧版本一起删掉; 现在一概不碰)
const existed = await exists(out);
await fs.mkdir(resource, { recursive: true });
if (existed) {
  console.log("目标目录已存在, 只覆盖同名文件, 旧版本与其它文件都不会动");
}
console.log("输出目录: " + out);

// 2) 程序本体、界面、素材 → resource/
for (const name of ["src", "web", "assets"]) {
  await fs.cp(path.join(root, name), path.join(resource, name), { recursive: true });
}

// 3) 窗口外壳 → resource/desktop/
const built = (await exists(path.join(root, "desktop", "target", "release", "voice-shell.exe")))
  ? path.join(root, "desktop", "target", "release")
  : path.join(root, "desktop");
await fs.mkdir(path.join(resource, "desktop"), { recursive: true });
const shell = path.join(built, "voice-shell.exe");
if (await exists(shell)) {
  await fs.copyFile(shell, path.join(resource, "desktop", "voice-shell.exe"));
  console.log("外壳: resource/desktop/voice-shell.exe " + mb((await fs.stat(shell)).size));
} else {
  console.log("[!] 没找到 voice-shell.exe, 发布包会退回浏览器窗口模式");
}

// 4) 自带 Node 运行时 → resource/runtime/
await fs.mkdir(path.join(resource, "runtime"), { recursive: true });
const nodeExe = process.execPath;
await fs.copyFile(nodeExe, path.join(resource, "runtime", "node.exe"));
console.log("运行时: resource/runtime/node.exe " + mb((await fs.stat(nodeExe)).size));

// 5) 启动入口(改名成用户看到的名字, 放在最外面)
const launcher = path.join(built, "voice-launcher.exe");
if (await exists(launcher)) {
  await fs.copyFile(launcher, path.join(out, "LoL_Voice.exe"));
  console.log("入口: LoL_Voice.exe " + mb((await fs.stat(launcher)).size));
} else {
  console.log("[!] 没找到 voice-launcher.exe, 先跑: cd desktop && cargo build --release");
}

// 6) 清掉"低完整性"标记: 带该标记的 exe 只能低权限运行, 而 Windows 禁止低权限进程
//    注册托盘图标(Shell_NotifyIcon 会返回 5 拒绝访问)。
spawnSync("icacls", [out, "/setintegritylevel", "(OI)(CI)M", "/T", "/C", "/Q"], { stdio: "ignore" });
console.log("完整性标记: 已清理(改为中完整性)");

// 6.5) 提醒: 语音包属于用户数据, 不该随包发出去
if (await exists(path.join(resource, "language"))) {
  const packs = await fs.readdir(path.join(resource, "language")).catch(() => []);
  console.log("[!] 注意: resource\\language\\ 里有 " + packs.length + " 个语音包(" + packs.join(", ") + ")");
  console.log("    发给用户前记得清掉 —— 用户自己在界面里下载即可");
}

// 7) 统计
const size = await measure(out);
console.log("\n发布包: " + size.files + " 个文件, " + mb(size.bytes));
console.log("把这个文件夹发出去就行: " + path.basename(out));
