/** 测试脚手架: 一切都在项目内的 .tmp/tests 下建临时目录, 绝不触碰真实游戏文件。 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(projectRoot, ".tmp", "tests");

let counter = 0;
let suite = "default";

/**
 * 每个测试文件声明自己的套件名: 临时目录按套件隔离,
 * 清理时只删自己那一份 —— 多文件共进程跑(node --test-isolation=none)时互不干扰。
 */
export function useSuite(name: string): void {
  suite = name;
}

/** 建目录(测试里多处要用)。 */
export async function makeDirSafe(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function makeTempDir(prefix = "case"): Promise<string> {
  counter += 1;
  const dir = path.join(tmpRoot, suite, `${prefix}-${process.pid}-${counter}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 只清理本套件的临时目录。 */
export async function cleanupSuite(): Promise<void> {
  await fs.rm(path.join(tmpRoot, suite), { recursive: true, force: true }).catch(() => undefined);
}

export async function cleanupTempRoot(): Promise<void> {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
}

export async function writeFile(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

export async function readFile(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

export interface FinalFixtureOptions {
  champions?: string[];
  maps?: string[];
  lang?: boolean;
}

/** 造一个假的 Game\DATA\FINAL(国服原版槽位)。 */
export async function makeFinalDir(dir: string, options: FinalFixtureOptions = {}): Promise<string> {
  const champions = options.champions ?? ["Ahri", "Yasuo"];
  const maps = options.maps ?? ["Map11"];
  for (const name of champions) {
    await writeFile(path.join(dir, "Champions", `${name}.zh_CN.wad.client`), `CN-${name}`);
  }
  for (const name of maps) {
    await writeFile(path.join(dir, "Maps", "Shipping", `${name}.zh_CN.wad.client`), `CN-${name}`);
  }
  if (options.lang !== false) {
    await writeFile(path.join(dir, "Localized", "Global.zh_CN.wad.client"), "CN-LANG");
  }
  return dir;
}

export interface PackFixtureOptions {
  champions?: string[];
  maps?: string[];
  lang?: boolean;
  lobby?: number;
  /** 额外写入的原始文件名 -> 内容(用于构造畸形资源)。 */
  extras?: Record<string, string>;
}

/** 造一个假的语种包 <root>/<locale>/DATA/FINAL + assets。 */
export async function makePack(root: string, locale: string, options: PackFixtureOptions = {}): Promise<string> {
  const champions = options.champions ?? ["Ahri", "Yasuo"];
  const maps = options.maps ?? ["Map11"];
  const final = path.join(root, locale, "DATA", "FINAL");
  for (const name of champions) {
    await writeFile(path.join(final, "Champions", `${name}.${locale}.wad.client`), `${locale}-${name}`);
  }
  for (const name of maps) {
    await writeFile(path.join(final, "Maps", "Shipping", `${name}.${locale}.wad.client`), `${locale}-${name}`);
  }
  if (options.lang !== false) {
    await writeFile(path.join(final, "Localized", `Global.${locale}.wad.client`), `${locale}-LANG`);
  }
  const lobbyCount = options.lobby ?? 2;
  for (let i = 0; i < lobbyCount; i += 1) {
    await writeFile(path.join(root, locale, "assets", "champion-choose-vo", `${100 + i}.ogg`), `${locale}-vo-${i}`);
  }
  for (const [relative, content] of Object.entries(options.extras ?? {})) {
    await writeFile(path.join(root, locale, relative), content);
  }
  return path.join(root, locale);
}

export interface LeagueFixture {
  leagueDir: string;
  finalDir: string;
}

/** 造一个假的联盟安装(LeagueClient + Game\DATA\FINAL)。 */
export async function makeLeagueInstall(root: string, options: FinalFixtureOptions = {}): Promise<LeagueFixture> {
  const leagueDir = path.join(root, "LeagueClient");
  await writeFile(path.join(leagueDir, "LeagueClient.exe"), "fake-exe");
  await writeFile(path.join(leagueDir, "Config", "LeagueClientSettings.yaml"), 'locale: "zh_CN"\nother: 1\n');
  const gameDir = path.join(root, "Game");
  await writeFile(path.join(gameDir, "League of Legends.exe"), "fake-game-exe");
  const finalDir = path.join(gameDir, "DATA", "FINAL");
  await makeFinalDir(finalDir, options);
  return { leagueDir, finalDir };
}


