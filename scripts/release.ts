/**
 * 生成发布包: release/LoL_Voice_<版本>/  —— 给最终用户的免安装版本。
 *
 * 用户的电脑上不需要任何环境:
 *   - LoL_Voice.exe   双击它就能用(Rust 启动器, 图标是使用者设计的 voicepack.ico)
 *   - runtime/node.exe 自带的 Node 运行时(用户不用装)
 *
 * 用法:
 *   node scripts/release.ts   生成 release/LoL_Voice_0.01/
 *
 * 刻意不打包(用户用不到, 只会占地方):
 *   tests/  docs/  scripts/  .tmp/  .git/  desktop/src  desktop/target
 *   tsconfig.json  config.json(用户自己的配置)  language/(用户自己的语音包)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 版本号: 发布就改这里(文件夹名跟着变)。 */
const VERSION = "0.01";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "release", `LoL_Voice_${VERSION}`);

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

// 1) 清空 release/ 再建版本文件夹(保证每次都是干净的包)
await fs.rm(path.join(root, "release"), { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
console.log("输出目录: " + out);

// 2) 程序本体与素材
for (const name of ["src", "web", "assets"]) {
  await fs.cp(path.join(root, name), path.join(out, name), { recursive: true });
}

// 3) 窗口外壳 + 启动器(都带图标; 启动器改名成用户看到的名字)
const built = path.join(root, "desktop", "target", "release");
await fs.mkdir(path.join(out, "desktop"), { recursive: true });
const shell = path.join(built, "voice-shell.exe");
if (await exists(shell)) {
  await fs.copyFile(shell, path.join(out, "desktop", "voice-shell.exe"));
} else {
  console.log("[!] 没找到 voice-shell.exe, 发布包会退回浏览器窗口模式");
}
const launcher = path.join(built, "voice-launcher.exe");
if (await exists(launcher)) {
  await fs.copyFile(launcher, path.join(out, "LoL_Voice.exe"));
  console.log("入口: LoL_Voice.exe " + mb((await fs.stat(launcher)).size));
} else {
  console.log("[!] 没找到 voice-launcher.exe, 先跑: cd desktop && cargo build --release");
}

// 4) 自带 Node 运行时(免安装的关键)
await fs.mkdir(path.join(out, "runtime"), { recursive: true });
const nodeExe = process.execPath;
await fs.copyFile(nodeExe, path.join(out, "runtime", "node.exe"));
console.log("运行时: node.exe " + mb((await fs.stat(nodeExe)).size));

// 5) 给用户的说明
const readme = [
  "LoL Voice  " + VERSION + "  —— 免安装版",
  "",
  "怎么用",
  "  双击 LoL_Voice.exe 即可。不需要安装任何东西。",
  "  它是绿色软件: 整个文件夹可以随便放(桌面、D 盘都行), 卸载就是删掉文件夹。",
  "",
  "第一次使用",
  "  1. 确认界面上的游戏路径(一般会自动找到; 找不到就点自动搜索或手填)",
  "  2. 先点下载语音包拿到语音包, 再在下拉栏里选中",
  "  3. 点开启语音包",
  "",
  "注意",
  "  开启后请勿通过 WeGame 启动, 直接启动英雄联盟客户端",
  "  想用对局选人语音, 开着本软件就行",
  "  不想用了, 点还原即可",
  "",
  "常见问题",
  "  双击没反应: 很可能已经在运行了 —— 看看右下角托盘(可能在隐藏的图标里)",
  "  窗口不见了: 标题栏右侧第二个按钮是收进托盘",
  "",
  "文件说明",
  "  LoL_Voice.exe  启动入口",
  "  src\\  web\\  程序本体与界面",
  "  runtime\\      自带的 Node 运行时(不要删)",
  "  desktop\\      窗口外壳",
  "  assets\\       图标等素材",
  "  language\\     语音包放这里(首次运行自动创建)"
].join("\r\n") + "\r\n";
await fs.writeFile(path.join(out, "README.txt"), readme, "utf8");

// 6) 统计
const size = await measure(out);
console.log("\n发布包: " + size.files + " 个文件, " + mb(size.bytes));
console.log("直接把这个文件夹发出去就行: " + path.basename(out));
