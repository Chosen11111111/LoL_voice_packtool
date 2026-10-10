# League Voice · 英雄联盟语音包/语言包切换器（独立后端）

把原先依附在其它项目里的 Python 脚本，重写成**独立、可直接分发**的 TypeScript 后端。

- **零运行时依赖**：只用 Node 内置模块（`node:http` / `node:fs` / `node:https` / `node:child_process`），不需要 `npm install` 就能跑。
- **Node 直跑 TS**：Node ≥ 20.11 原生类型擦除，`node src/index.ts` 即启动；`tsc` 只用于类型检查。
- **两种驱动方式**：命令行（CLI）+ HTTP/SSE API（给未来的 Electron / 网页界面用），两者共用同一套业务实现。
- **可验证**：46 个自动化测试，全部在临时目录里跑，绝不触碰真实游戏文件。

---

## 1. 快速开始

| 目的 | 命令 |
| --- | --- |
| 图形控制台（内置网页界面） | 双击 `start.cmd`，或 `npm run serve` |
| 查看当前状态 | 双击 `status.cmd`，或 `npm run status` |
| 增量同步语言包 | 双击 `update-packs.cmd`，或 `npm run start -- update run` |
| 环境自检 | `npm run doctor` |
| 类型检查 / 测试 | `npm run typecheck` / `npm test` |

要求：Windows 10/11 + Node.js ≥ 20.11（推荐 22/24）。运行时不需要任何第三方依赖。

## 2. 命令行

```text
league-voice <命令> [选项]

status                       显示路径与对局端/大厅端当前状态
locales                      列出可用语言包及其资源齐备情况
plan [--locale ja_JP]        切换前干跑预检(只读)
apply [--locale ja_JP]       切换 [--modules lobby_voice,ingame_voice,ingame_lang] [--restart=false]
restore                      恢复官方国服默认 [--modules ...] [--restart=false]
oneclick apply|restore       一键全套 / 一键还原
update check|run             检查更新 / 增量同步语言包 [--locales ja_JP,ko_KR]
plugin install [--force]     安装大厅语音插件到 Pengu Loader
paths                        列出所有探测到的游戏安装路径
doctor                       环境自检
config get|set k=v|path      查看/修改配置
serve [--host] [--port]      启动后端服务(默认 http://127.0.0.1:43110)
```

全局选项：`--json`（机器可读输出）、`--log debug|info|warn|error`。

## 3. HTTP API

服务默认只监听 `127.0.0.1`；`server.token` 非空时所有请求都要带 `X-Auth-Token`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与版本 |
| GET | `/api/state` | 首页聚合状态（路径/对局端/大厅端/进程/任务） |
| GET | `/api/locales?stats=0` | 可用语言包列表及当前生效项 |
| GET | `/api/paths` | 路径解析结果 + 所有候选安装 |
| GET/PUT | `/api/config` | 读取 / 合并写入配置 |
| POST | `/api/plan` | 干跑预检：资源、磁盘、阻塞项（只读） |
| POST | `/api/apply` | 启动切换任务 |
| POST | `/api/restore` | 启动还原任务 |
| POST | `/api/oneclick/apply` `/restore` | 一键全套 / 一键还原 |
| POST | `/api/update/check` `/run` | 检查更新 / 增量同步 |
| POST | `/api/plugin/install` | 安装/重装大厅语音插件 |
| GET | `/api/tasks` `/api/tasks/:id` | 任务列表 / 详情（含结果与日志） |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| GET | `/api/events` | SSE：`progress` / `log` / `done` / `state` 事件 |

长任务（切换/还原/同步）一律异步执行并返回 `task.id`，进度通过 SSE 或轮询 `/api/tasks/:id` 获取；同一时刻只会有一个"切换类"任务在跑。

## 4. 目录结构

```text
src/
  index.ts            入口
  cli.ts              命令行
  service.ts          业务入口(CLI 与 API 共用)
  version.ts          版本与兼容后缀常量
  core/               基础设施
    config.ts         配置存储(config.json, 原子写)
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
    locales.ts        语种目录识别与扫描
    wad.ts            wad 匹配与目标命名
    inventory.ts      资源校验/状态/工作量/磁盘估算
    updater.ts        清单下载、CommunityDragon 增量同步、版本检查
  pengu/
    loader.ts         d3d9 加载桩、Rose 配置、精简语音加载器
    plugin.ts         Chosen-VoiceSync 插件安装与资源挂载
  modules/
    applyPlan.ts      替换计划执行器(预检槽位 + 逐文件安全替换)
    ingameVoice.ts    对局语音
    ingameLang.ts     对局语言
    lobbyVoice.ts     大厅选人语音
    lobbyLang.ts      大厅界面语言
    oneclick.ts       一键全套 / 一键还原
  tasks/manager.ts    任务队列、进度、取消、互斥
  server/             HTTP 路由 + REST API
assets/pengu-plugin/  内置的 Chosen-VoiceSync 插件模板
tests/                自动化测试(node:test)
web/                  内置网页控制台
```

## 5. 设计要点（从旧脚本继承的硬约束）

1. **路径只解析一次**：开启/还原/状态查询共用同一次解析结果；配置路径与正在运行的客户端不一致时**直接报冲突停止**，绝不改错安装目录。
2. **目标文件永不先删后写**：备份用硬链接（零拷贝），不支持硬链接时复制到 `<备份>.part`，复制完整后才原子改名为 `.chosen_bak`。中途被强杀只会留下 `.part`，状态查询与还原都只认正式备份名。
3. **失败必须回到原状**：任何一步出错都会清掉本次新建的备份与临时文件，避免"没换成"被状态查询误判成"已开启"。
4. **槽位预检**：游戏里本来没有的 `.zh_CN.wad.client` 不会被新建（新建也不会被加载），记为"目标槽位缺失"。
5. **语种严格隔离**：只接受 `<名字>.<语种>.wad.client` 或无后缀文件；语言包额外限定 `Global`，绝不把别的 wad 写到错误目标。
6. **对局中禁止操作**：检测到 `League of Legends.exe` 直接拒绝切换/还原。
7. **大厅语音可即时停用**：还原时写 `config.json` 的 `enabled=false`，即使插件已在内存里也立刻停止拦截音频。

## 6. 配置

配置放在项目根目录的 `config.json`（不提交到仓库；可用 `config.example.json` 起步）。
所有字段都有默认值，留空即"自动探测"：

| 字段 | 说明 |
| --- | --- |
| `voiceRoot` | 语音包资源根目录（含 `ja_JP` / `ko_KR` / `en_US` 等子目录） |
| `leaguePath` | 联盟客户端目录（含 `LeagueClient.exe`） |
| `gamePath` | 游戏本体目录（含 `League of Legends.exe`），一般留空自动推导 |
| `penguLoaderDir` | Pengu Loader 目录（含 `core.dll`、`d3d9_stub.dll`） |
| `manifestDownloader` | 清单下载器文件名/路径（增量拉取 wad 用） |
| `bundleProxy` / `manifestId` | 切片加速代理与官方清单 ID |
| `supportedLocales` | 需要维护的语种列表 |
| `autoRestartClient` | 切换/还原成功后是否自动重启客户端 UX |
| `server` | API 监听地址、端口、访问令牌 |

也支持环境变量：`LEAGUE_VOICE_ROOT`、`LEAGUE_PATH`、`LEAGUE_VOICE_PENGU`、`LEAGUE_VOICE_CONFIG`、`LEAGUE_VOICE_HOME`。

## 7. 开发

```bash
npm run typecheck   # tsc 类型检查(仅类型, 不产出 JS)
npm test            # node:test 全部用例
node src/index.ts serve --port 43110
```

测试策略：单元测试覆盖 wad 匹配、语种识别、路径解析、文件替换原语；集成测试在临时目录里造出"假游戏安装 + 假 Pengu Loader"，验证「切换 → 状态 → 还原」全链路，以及通过 HTTP API 跑完整流程。
