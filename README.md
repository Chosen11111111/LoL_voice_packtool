# League Voice · 英雄联盟语音包/语言包切换器（独立后端）

把原先依附在其它项目里的 Python 脚本，重写成**独立、可直接分发**的 TypeScript 后端。

- **零运行时依赖**：只用 Node 内置模块（`node:http` / `node:fs` / `node:child_process`），不需要 `npm install` 就能跑。
- **Node 直跑 TS**：Node 22.18+（22.x）或 24+ 原生类型擦除，`node src/index.ts` 即启动；`tsc` 只用于类型检查。
- **国服 / 国际服同一套流程**：替换哪一类槽位文件由"客户端基准语种"决定，不写死 `zh_CN`。
- **两种驱动方式**：命令行（CLI）+ HTTP/SSE API，两者共用同一套业务实现（`src/service.ts`）。
- **可验证**：自动化测试覆盖文件替换/还原、并发配置、任务状态、流式上传下载和取消，使用临时目录与本地测试服务。

---

## 1. 快速开始

| 目的 | 命令 |
| --- | --- |
| 启动（后端 + 应用窗口） | 双击 `start.cmd`，或 `npm run app` |
| 只起后端（浏览器访问） | `npm run serve` |
| 查看当前状态 | 双击 `status.cmd`，或 `npm run status` |
| 增量同步语言包 | 双击 `update-packs.cmd` |
| 环境自检 | `npm run doctor` |
| 类型检查 / 测试 | `npm run typecheck` / `npm test` |

要求：Windows 10/11 + Node.js 22.18+（22.x）或 24+（推荐 24）。运行时不需要任何第三方依赖。[原生 TypeScript 支持说明](https://nodejs.org/download/release/latest-jod/docs/api/typescript.html#type-stripping)。

## 2. 界面

`web/` 是自带的控制台（概览 / 语音包 / 更新与下载 / 设置 / 运行日志）。

`start.cmd` 会用 Edge/Chrome 的 `--app` 模式把界面开成**独立应用窗口**（无地址栏、独立任务栏图标），
并给它一个私有 profile（`.app-profile/`）。**关闭该窗口 = 退出程序**，后端随之停止。
机器上没有 Edge/Chrome 时退回系统默认浏览器；`node src/app.ts --no-window` 则只起后端。

### 换成自己的 UI

- 把前端产物放进 `web/`，或在 `config.json` 里改 `"server": { "webDir": "dist" }`
- 前端路由刷新不会 404（未命中的 GET 页面请求兜底到 `index.html`；`/api/*` 仍是 JSON 404）
- 也可以完全独立：前端自己起服务（Vite / Electron），把 `http://127.0.0.1:43110` 当后端用（跨域已放开）
- 后端不含任何 UI 假设：不注入 HTML、不读前端状态、不绑定框架。**唯一的约定是 [docs/API.md](docs/API.md)**

## 3. 命令行

```text
league-voice <命令> [选项]

status                       显示路径与对局端/大厅端当前状态
locales                      列出可用语言包及其资源齐备情况
plan [--locale ja_JP]        切换前干跑预检(只读)
apply [--locale ja_JP]       切换 [--modules ingame_voice,ingame_lang] [--restart=false]
restore                      恢复客户端原版 [--modules ...] [--restart=false]
oneclick apply|restore       一键全套 / 一键还原
update check|run             检查更新 / 增量同步语言包 [--locales ja_JP,ko_KR]
plugin install [--force]     安装大厅语音插件到加载器
paths                        列出所有探测到的游戏安装路径
doctor                       环境自检
config get|set k=v|path      查看/修改配置
serve [--host] [--port]      启动后端服务(默认 http://127.0.0.1:43110)
```

全局选项：`--json`（机器可读输出）、`--log debug|info|warn|error`。

## 4. 国服 / 国际服的适配

同一套流程适配两种客户端，靠的是**基准语种**（客户端当前语种），而不是写死 `zh_CN`：

| 客户端 | 游戏内槽位文件 | 后端行为 |
| --- | --- | --- |
| 国服 WeGame | `Ahri.zh_CN.wad.client` | 基准语种 `zh_CN`，替换 `.zh_CN` 槽位 |
| 国际服 Riot | `Ahri.zh_TW.wad.client`（随客户端语种） | 自动探测 `zh_TW`，替换 `.zh_TW` 槽位 |

替换目标、状态判断、还原、备份识别、磁盘估算全部跟随基准语种；客户端语种变更后遗留的旧备份也能正常还原。
探测顺序：配置 `baseLocale` > 游戏文件里的语种多数票 > 客户端设置 `locale` > `zh_CN`。

`GET /api/client` 会返回当前判定结果（`region` / `base_locale` / `target_suffix`）。

## 5. 语音包压缩包导入

选一个压缩包 → 解压到资源目录内的临时目录 → 识别结构与语种 → **同卷改名**安装成
`<资源目录>/<语种>/DATA/FINAL/...`。装完立刻出现在 `GET /api/locales`，下拉栏直接可选、可直接切换。

- 支持 `zip` / `tar` / `tar.gz` / `tgz`（系统自带工具）；`7z` / `rar` 需要本机装 7-Zip 或 WinRAR
- 压缩包内只要有 `DATA/FINAL`（Champions / Maps / Localized）或 `assets/champion-choose-vo`，外层多套一层目录也能自动找到
- 语种识别：`?locale=` 显式指定 > 压缩包文件名 > 包内目录名 > 包内 wad 后缀 > 用压缩包名当自定义包名
- 上传是**流式落盘**，不占内存、默认不限大小；几个 GB 的包也可以直接给本机路径（`{ "path": "E:\\packs\\jp.zip" }`）

接口细节见 [docs/API.md](docs/API.md#post-apipacksimport--导入语音包压缩包)。

## 6. HTTP API

服务默认只监听 `127.0.0.1`；`server.token` 非空时所有请求都要带 `X-Auth-Token`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与版本 |
| GET | `/api/state` | 首页聚合状态（路径/对局端/大厅端/进程/任务） |
| GET | `/api/client` | 客户端渠道（国服/外服）与基准语种、目标槽位后缀 |
| GET | `/api/locales?stats=0` | 可用语言包列表及当前生效项 |
| GET | `/api/paths` | 路径解析结果 + 所有候选安装 |
| GET/PUT | `/api/config` | 读取 / 合并写入配置 |
| POST | `/api/plan` | 干跑预检：资源、磁盘、阻塞项（只读） |
| POST | `/api/apply` | 启动切换任务 |
| POST | `/api/restore` | 启动还原任务 |
| POST | `/api/packs/import` | 导入语音包压缩包（上传或本机路径） |
| POST | `/api/update/check` `/run` | 检查更新 / 增量同步 |
| GET | `/api/tasks` `/api/tasks/:id` | 任务列表 / 详情（含结果与日志） |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| GET | `/api/events` | SSE：`progress` / `log` / `done` / `state` 事件 |

长任务（切换/还原/同步/导入）一律异步执行并返回 `task.id`，进度通过 SSE 或轮询 `/api/tasks/:id` 获取；
同一时刻只会有一个"切换类"任务在跑。

## 7. 目录结构

```text
src/
  index.ts            入口(CLI)
  app.ts              应用模式: 后端 + 应用窗口
  cli.ts              命令行
  service.ts          业务入口(CLI 与 API 共用)
  version.ts          版本与兼容后缀常量
  core/               基础设施
    config.ts         配置存储(config.json, 原子写, features 开关)
    paths.ts          游戏路径统一解析(配置/进程/注册表/元数据/扫描)
    fsx.ts            安全替换原语(硬链接备份/原子改名/目录联接)
    result.ts         结构化结果与汇总
    errors.ts         错误归类(中文原因)
    logger.ts         分级日志
    win/              Windows 适配
      processes.ts    进程探测(对局/客户端/LCU 凭据)
      lcu.ts          LCU 本地 API(重启 UX 等)
      registry.ts     注册表读取
      shell.ts        子进程封装(管道受限时自动退回文件重定向)
      ansi.ts         ANSI/GBK 文本写入
  packs/
    baselocale.ts     基准语种与渠道探测(国服/外服适配的核心)
    locales.ts        语种目录识别与扫描
    wad.ts            wad 匹配与目标命名
    inventory.ts      资源校验/状态/工作量/磁盘估算
    archive.ts        压缩包解压/结构识别/语种识别/导入
    wadfile.ts        客户端自带资源包(RW WAD)定位与解析
    updater.ts        清单下载、CommunityDragon 增量同步、版本检查
  modules/
    applyPlan.ts      替换计划执行器(预检槽位 + 逐文件安全替换)
    ingameVoice.ts    对局语音
    ingameLang.ts     对局语言
    lobbyVoice.ts     对局前选人语音(LCU 监听 + 本地播报, 默认关闭)
    lobbyLang.ts      大厅界面语言
    oneclick.ts       一键全套 / 一键还原
  tasks/manager.ts    任务队列、进度、取消、互斥
  server/             HTTP 路由 + REST API + 流式上传
tests/                自动化测试(node:test)
web/                  自带控制台
docs/API.md           接口契约
```

## 8. 设计要点（从旧脚本继承的硬约束）

1. **路径只解析一次**：开启/还原/状态查询共用同一次解析结果；配置路径与正在运行的客户端不一致时**直接报冲突停止**，绝不改错安装目录。
2. **目标文件永不先删后写**：备份用硬链接（零拷贝），不支持硬链接时复制到 `<备份>.part`，复制完整后才原子改名为 `.chosen_bak`。中途被强杀只会留下 `.part`，状态查询与还原都只认正式备份名。
3. **失败必须回到原状**：任何一步出错都会清掉本次新建的备份与临时文件，避免"没换成"被状态查询误判成"已开启"。
4. **槽位预检**：游戏里本来没有的槽位文件不会被新建（新建也不会被加载），记为"目标槽位缺失"。
5. **语种严格隔离**：只接受 `<名字>.<语种>.wad.client` 或无后缀文件；语言包额外限定 `Global`，绝不把别的 wad 写到错误目标。
6. **对局中禁止操作**：检测到 `League of Legends.exe` 直接拒绝切换/还原。
7. **备份识别不绑语种**：客户端语种变过、或历史遗留的备份，都能被状态查询发现并还原。

## 9. 配置

配置放在项目根目录的 `config.json`（不提交到仓库；可用 `config.example.json` 起步）。
界面修改语音包选择、三个勾选项、播报音量、音量跟随和区服后，会自动保存到这个文件的 `ui` 字段，重启后恢复。底部显示“配置已保存”；悬停可查看实际文件路径。首次启动会迁移旧浏览器缓存里的音量设置，之后以文件为准。明确取消选择、取消勾选和音量 `0` 也会保留。恢复界面选择不会自动替换游戏文件。
所有字段都有默认值，留空即"自动探测"：

| 字段 | 说明 |
| --- | --- |
| `voiceRoot` | 语音包资源根目录（含 `ja_JP` / `ko_KR` 等子目录） |
| `leaguePath` | 联盟客户端目录（含 `LeagueClient.exe`） |
| `gamePath` | 游戏本体目录（含 `League of Legends.exe`），一般留空自动推导 |
| `baseLocale` | 客户端基准语种（决定替换哪个槽位文件）。留空 = 自动探测 |
| `defaultLocale` | 默认语音包语种 |
| `supportedLocales` | 需要维护的语种列表（增量同步用） |
| `manifestDownloader` / `bundleProxy` / `manifestId` | wad 增量下载工具与代理、官方清单 ID |
| `autoRestartClient` | 切换/还原成功后是否自动重启客户端 UX |
| `features.lobbyVoice` | 对局前选人语音（默认 `false`；LCU 监听 + 本地播报，界面勾选即开启） |
| `features.lobbyLang` | 大厅界面语言（改 `LeagueClientSettings.yaml`，与语音包无关） |
| `server` | API 监听地址、端口、访问令牌、前端目录、上传上限 |
| `ui` | 窗口偏好：`selectedLocale`、`modules`、`volume`（0–100）、`followClient`、`region`（`auto` / `cn` / `global`） |

也支持环境变量：`LEAGUE_VOICE_ROOT`、`LEAGUE_PATH`、`LEAGUE_VOICE_CONFIG`、`LEAGUE_VOICE_HOME`。

## 10. 开发

```bash
npm run typecheck   # tsc 类型检查(仅类型, 不产出 JS)
npm test            # node:test 全部用例
npm run app         # 后端 + 应用窗口
node src/index.ts serve --port 43110
```

测试策略：全部在项目内 `.tmp/tests/` 下造"假游戏安装 + 假加载器"，覆盖替换/还原/槽位缺失/跨语种隔离/国服外服槽位跟随/压缩包导入/HTTP 全链路，
**不会触碰真实游戏文件**。

## 实测记录：为什么不能改客户端资源包

选人/禁用台词由客户端自带的资源包提供：

```
LeagueClient\Plugins\rcp-be-lol-game-data\<客户端语种>-assets.wad
```

早期尝试过**直接替换资源包内条目的音频数据**（不注入任何进程）。结论：**行不通**，以下是实测证据。

实测确认的 WAD 结构（RW 3.4）：

| 偏移 | 内容 |
| --- | --- |
| 0..3 | `RW` + 版本 |
| 4..267 | 256 字节签名块 + 8 字节校验 |
| 268..271 | 条目数 u32 |
| 272.. | TOC：每条 32 字节（`+8`=数据偏移，`+12`/`+16`=大小，`+24`=路径哈希） |
| TOC 之后 | 数据区 |

当时的补丁方式（代码保留在 src/packs/wadfile.ts，但已不是默认路径）：

1. 首次补丁前把原文件整体备份为 `<wad>.chosen_bak`（永不覆盖）；
2. 新音频按 16 字节对齐**追加到文件末尾**；
3. 只更新对应条目的偏移与大小，签名块、条目顺序、条目数一律不动；
4. 先写 `<wad>.chosen_new` 再原子改名，中途失败不会破坏原文件。

失败原因：日志报 fatal 级别的 WadFile chunk verification failed，条目 +24 字段是内容校验值（客户端会重算比对）。试过 40 种常见哈希算法 × 120 个真实条目全部不匹配；连「数据一个字节不改、只把数据搬到文件尾部并更新偏移」都会让客户端黑屏。现在这条路已放弃，改用上面的 LCU 监听 + 本地播放。

命令行：

```
node src/index.ts lobby status  [--league <客户端目录>]
node src/index.ts lobby apply   [--locale ja_JP] [--league <客户端目录>]
node src/index.ts lobby restore [--league <客户端目录>]
```

> 替换时客户端必须完全退出（文件被占用无法替换，工具会明确拒绝而不是硬来）。
> 国服 `zh_CN-assets.wad` 里有 351 个 ogg（173 选人 + 173 禁用）；
> 国际服当前渠道的语种包里没有选人语音（`zh_TW-assets.wad` 只有 5 个 ogg）。

## 选人语音（LCU 监听 + 本地播放，客户端零改动）

客户端资源包 `Plugins/rcp-be-lol-game-data/<语种>-assets.wad` **有严格的内容校验**，实测结论：

- 日志会报 `FATAL ERROR - Installation is corrupt. WadFile chunk verification failed.`
- 报错里给出 `Chunk`（条目的 `+0` 字段）、`Expected`（条目 `+24` 字段）、`Actual`（客户端算出的值）、`Size`
- 试过 40 种常见算法（xxh64 各种 seed / FNV / MurmurHash64A·B / SHA·MD5 截断 / CRC64）× 120 个真实条目，**零命中** —— 校验值是私有的，伪造不了
- 最温和的修改（数据一个字节不改、只把数据搬到文件尾部并更新偏移）也会让客户端黑屏

因此选人台词改成**工具自己在外面播**，客户端一个字节都不用动：

```
LCU 轮询 /lol-champ-select/v1/session
        ↓ 推导事件（自己 hover/lock 选人 → choose；自己 ban → ban）
  SSE 推 event: lobby 给工具窗口
        ↓
  窗口里的 <audio> 播放 <资源根>/<语种>/assets/champion-{choose,ban}-vo/<id>.ogg
```

使用方式：打开工具（界面里选中的语种就是播报语种，自动开始监听），进选人即可听到。排障用命令行：

```
node src/index.ts lobby-live --locale ja_JP [--others]
```

要点：

- 客户端界面语言完全不受影响（中文依旧），因为是外部播放；
- 换英雄会立刻切掉上一条，不会叠音；同一英雄同一类型 8 秒内不重复播；
- 默认只播**自己**的选人/禁用；`--others` 或 API 的 `includeOthers` 可把别人的禁用也一起播；
- 播放端就是工具窗口（Chromium 原生支持 ogg/vorbis，零解码依赖）；应用窗口启动时带 `--autoplay-policy=no-user-gesture-required`，不需要先点一下才出声。


### 国服客户端的 LCU 凭据怎么拿（ACE 反作弊环境）

国服客户端由 WeGame 以管理员权限启动，并受 ACE 反作弊（`ACE-BASE.sys` 内核驱动）保护：
即使本工具提权，也读不到 `LeagueClientUx.exe` 的命令行与可执行路径，装好的 `lockfile` 还是空的。

可用的来源是**客户端自己的日志**（启动时它会把命令行原样写进第一行）：

```
E:\WeGameApps\英雄联盟\LeagueClient\<时间戳>_<pid>_LeagueClientUx.log
000000.000|   OKAY| Command line arguments: --riotclient-auth-token=… --riotclient-app-port=60990 --riotclient-tencent --region=TENCENT
```

凭据解析顺序（`src/core/win/processes.ts`）：

1. `LeagueClientUx.exe` 命令行：`--app-port` + `--remoting-auth-token`（国际服）；
2. 同上但只有 `--riotclient-app-port` + `--riotclient-auth-token`（国服走这套，日志里也带）；
3. 都拿不到时读客户端日志（只读前 32KB，带 20 秒缓存）。

这套办法**不需要提权、不碰反作弊**，纯文件读取。

