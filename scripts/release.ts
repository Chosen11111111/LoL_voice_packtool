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
const VERSION = "1.23";

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

/**
 * 覆盖一个可能正在被占用的文件: 先写临时文件再改名。
 * 目标正被运行中的进程/杀软占用时, 保留旧文件并提示, 不让整个打包失败
 * (同一版本重建时旧文件内容通常一样; 换了新文件则下次关闭程序后再打一次)。
 */
async function replaceBestEffort(src: string, dest: string, label: string): Promise<boolean> {
  const temp = `${dest}.new-${process.pid}`;
  try {
    await fs.copyFile(src, temp);
    await fs.rename(temp, dest);
    return true;
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    console.log(`[!] ${label} 被占用，保留现有文件（${String((error as Error).message).slice(0, 90)}）`);
    return false;
  }
}

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

// 2b) 极窄范围的清理: 只清 assets/textpack 下"本次构建已经没有"的语言目录。
//     用户放进 resource\language\ 的语音包一律不碰 —— 那是用户自己的数据。
const srcPack = path.join(root, "assets", "textpack");
const dstPack = path.join(resource, "assets", "textpack");
const wanted = new Set(await fs.readdir(srcPack).catch(() => [] as string[]));
let cleaned = 0;
for (const name of await fs.readdir(dstPack).catch(() => [] as string[])) {
  if (wanted.has(name)) continue;
  await fs.rm(path.join(dstPack, name), { recursive: true, force: true }).catch(() => undefined);
  cleaned += 1;
}
if (cleaned) console.log("清理过期的文字包目录: " + cleaned + " 个");

// 2c) 旧的"每个语种一个插件"(assets/textpack/<语种>/plugin)已经废弃:
//     现在只有一个客户端插件 assets/client-plugin。这些生成物每份 2~3 MB, 不往发布包里带,
//     免得发布包白白大 10 MB, 也免得用户/以后的人以为还有第二份插件。
let dropped = 0;
for (const name of await fs.readdir(dstPack).catch(() => [] as string[])) {
  const legacy = path.join(dstPack, name, "plugin");
  if (!(await exists(legacy))) continue;
  await fs.rm(legacy, { recursive: true, force: true }).catch(() => undefined);
  dropped += 1;
}
if (dropped) console.log("清理已废弃的每语种插件目录: " + dropped + " 个");

// 2d) 旧版选人语音插件(assets/voice-sync)也已合并进 client-plugin, 不往发布包里带。
await fs.rm(path.join(resource, "assets", "voice-sync"), { recursive: true, force: true }).catch(() => undefined);

// 2e) 开发/测试运行留下的缓存目录绝对不能进发布包:
//     .app-profile 是浏览器窗口的独立 profile(几百个文件), .tmp 是本机日志。
for (const name of [".app-profile", ".tmp"]) {
  await fs.rm(path.join(resource, name), { recursive: true, force: true }).catch(() => undefined);
}
// 启动动画已改由 app.ts 内的 PowerShell 完成, assets/desktop 是早期备选方案, 不进发布包
await fs.rm(path.join(resource, "assets", "desktop"), { recursive: true, force: true }).catch(() => undefined);
// 空的语言包目录是运行时自动建的, 不该跟着发布包发出去(有用户的包就保留)
const langDir = path.join(resource, "language");
if ((await fs.readdir(langDir).catch(() => [] as string[])).length === 0) {
  await fs.rm(langDir, { recursive: true, force: true }).catch(() => undefined);
}

// 3) 窗口外壳 → resource/desktop/
const built = (await exists(path.join(root, "desktop", "target", "release", "voice-shell.exe")))
  ? path.join(root, "desktop", "target", "release")
  : path.join(root, "desktop");
await fs.mkdir(path.join(resource, "desktop"), { recursive: true });
const shell = path.join(built, "voice-shell.exe");
if (await exists(shell)) {
  const copied = await replaceBestEffort(shell, path.join(resource, "desktop", "voice-shell.exe"), "voice-shell.exe");
  console.log("外壳: resource/desktop/voice-shell.exe " + mb((await fs.stat(shell)).size) + (copied ? "" : "（沿用旧文件）"));
} else {
  console.log("[!] 没找到 voice-shell.exe, 发布包会退回浏览器窗口模式");
}

// 4) 自带 Node 运行时 → resource/runtime/
await fs.mkdir(path.join(resource, "runtime"), { recursive: true });
const nodeExe = process.execPath;
await replaceBestEffort(nodeExe, path.join(resource, "runtime", "node.exe"), "runtime/node.exe");
console.log("运行时: resource/runtime/node.exe " + mb((await fs.stat(nodeExe)).size));

// 5) 启动入口(改名成用户看到的名字, 放在最外面)
const launcher = path.join(built, "voice-launcher.exe");
if (await exists(launcher)) {
  await replaceBestEffort(launcher, path.join(out, "LoL_Voice.exe"), "LoL_Voice.exe");
  console.log("入口: LoL_Voice.exe " + mb((await fs.stat(launcher)).size));
} else {
  console.log("[!] 没找到 voice-launcher.exe, 先跑: cd desktop && cargo build --release");
}

// 5.5) 给用户的使用说明(放最外层, 用户一眼能看到)
const readmeSource = path.join(root, "docs", "使用说明.txt");
if (await exists(readmeSource)) {
  const text = (await fs.readFile(readmeSource, "utf8")).replaceAll("{{VERSION}}", VERSION);
  // 带 BOM: 老版本记事本、写字板打开中文才不会乱码
  await fs.writeFile(path.join(out, "使用说明.txt"), "\uFEFF" + text, "utf8");
  console.log("说明: 使用说明.txt");
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
