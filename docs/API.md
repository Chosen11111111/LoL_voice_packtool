# League Voice 后端接口契约

> 这份文档是**界面与后端之间唯一的约定**。任何前端（内置网页 / Electron / 你自己的框架）只要按这里调用即可，
> 后端不关心你用什么技术栈、什么视觉风格。改动破坏兼容时会提升 `api_version`。

- 默认地址：`http://127.0.0.1:43110`
- 监听地址、端口、令牌、前端目录都在 `config.json` 的 `server` 段：`{ host, port, token, webDir }`
- 所有接口返回 JSON（`/api/events` 除外，它是 SSE）
- 编码：UTF-8；时间戳：毫秒（epoch）

## 1. 鉴权

- `server.host` 为 `127.0.0.1`/`localhost` 且 `server.token` 为空时：**不校验**（本机使用默认如此）。
- 配置了 `server.token` 时，每个请求都要带：
  - 请求头 `X-Auth-Token: <token>`，或
  - 查询参数 `?token=<token>`
- 校验失败：`401 { "ok": false, "error": "unauthorized", "message": "缺少或错误的访问令牌" }`

## 2. 通用约定

成功：

```json
{ "ok": true, "...": "各接口自己的字段" }
```

失败（HTTP 状态码同时有意义）：

```json
{ "ok": false, "error": "not_found | bad_json | payload_too_large | internal_error | unauthorized", "message": "可直接展示给用户的中文说明" }
```

**长任务模型**：`/api/apply`、`/api/restore`、`/api/update/*` 不会阻塞等待，而是立刻返回 `task` 快照：

```json
{
  "ok": true,
  "task": {
    "id": "9f1c…", "kind": "oneclick_apply", "label": "切换语音包 → ja_JP",
    "status": "running",              // pending | running | succeeded | failed | cancelled
    "progress": { "done": 0, "total": 0, "percent": 0, "current": "" },
    "startedAt": 1791622997289, "finishedAt": null, "error": "", "hasResult": false
  }
}
```

同一时刻只允许一个"切换类"任务（`apply` / `restore` / 一键）：互斥时返回
`500 { "ok": false, "error": "internal_error", "message": "已有任务在进行中(…)，请等待完成后再试。" }`。
界面应在任务运行时禁用按钮，并可查 `/api/state` 的 `busy` 字段。

## 3. 接口一览

### GET /api/health
```json
{ "ok": true, "app": "League Voice", "app_cn": "英雄联盟 语音包/语言包 切换器",
  "version": "1.0.0", "api_version": 1, "node": "v24.16.0",
  "uptime_s": 42, "tasks_running": 0, "sse_clients": 1 }
```

### GET /api/state —— 首页聚合状态
```json
{
  "ok": true,
  "state": {
    "app":   { "name": "…", "version": "1.0.0", "appRoot": "E:\\…\\League_voice", "configPath": "…\\config.json" },
    "paths": { "finalDir": "…\\Game\\DATA\\FINAL", "gameDir": "…", "leagueDir": "…",
               "source": "registry|config|process|metadata|scan", "sourceDetail": "注册表 HKCU\\Software\\Tencent\\LOL",
               "mismatch": false, "message": "游戏文件目录：…" },
    "voiceRoot": "E:\\ChosenSkin2.0\\voice", "voiceRootSource": "sibling",
    "ingame": {
      "ok": true, "message": "游戏文件目录：…",
      "voice": "【已切换为：日服 (ja_JP)原声】", "lang": "【当前为：国服中文原版】",
      "is_voice_active": true, "is_lang_active": false,
      "active_locale": "ja_JP", "final_dir": "…", "source": "registry",
      "voice_backups": 180, "lang_backup": false
    },
    "lobby": {
      "ok": true, "voice": "已开启|官方默认", "lang": "未知", "enabled": true, "locale": "ja_JP",
      "stub_active": true, "assets_mounted": true, "loader_path": "…\\Pengu Voice",
      "pengu_dir": "…\\Pengu Loader", "plugin_dir": "…\\Chosen-VoiceSync",
      "plugin_installed": true, "message": "加载桩已就位"
    },
    "processes": { "game_running": false, "client_running": true },
    "tasks": [ /* 任务快照数组，最新的在前 */ ],
    "busy": { "switch": "9f1c…" }      // 互斥组 -> 占用它的任务 id
  }
}
```

### GET /api/locales?stats=0|1
`stats=0` 跳过逐项文件统计（快）。`stats=1`（默认）附带文件数。
```json
{ "ok": true, "root": "E:\\ChosenSkin2.0\\voice", "active_locale": "ja_JP",
  "locales": [{
    "code": "ja_JP", "name": "日服 (ja_JP)",
    "has_voice": true, "has_lang": true, "has_lobby": true, "has_maps": true,
    "voice_files": 174, "map_files": 6, "lang_files": 1, "lobby_files": 173,
    "root": "E:\\ChosenSkin2.0\\voice",
    "active": true,                                  // 是否当前生效语种
    "current": { "voice": true, "lang": false, "lobby": true }
  }] }
```

### GET /api/paths
```json
{ "ok": true,
  "resolution": { "finalDir": "…", "leagueDir": "…", "source": "registry", "mismatch": false, "message": "…" },
  "candidates": [ { "path": "…", "source": "registry", "sourceDetail": "…",
                    "hasClient": true, "leagueDir": "…", "gameDir": "…", "finalDir": "…" } ] }
```

### GET /api/config ・ PUT /api/config
`PUT` 请求体是**部分配置**（深合并 `server`/`download` 两个子对象），返回写盘后的完整配置。
字段含义见 `config.example.json`。

### POST /api/plan —— 干跑预检（只读，不改任何文件）
请求：`{ "locale": "ja_JP", "modules": ["lobby_voice","ingame_voice","ingame_lang"] }`
```json
{ "ok": true,
  "plan": {
    "ok": false,                                   // 有 blocker 就是 false
    "blockers": ["检测到游戏对局正在进行中，请退出对局后再切换。"],
    "warnings": ["需要复制文件（…）"],
    "checks": [ { "ok": true, "module": "ingame_voice", "module_name": "游戏内语音",
                  "planned": 180, "success": 0, "failed": 0, "missing": false,
                  "reason": "", "message": "英雄语音 174 个 / 播报员 6 个" } ],
    "space": { "ok": true, "needed": 0, "free": 312000000000, "requires_copy": false,
               "backup_bytes": 0, "temp_bytes": 0, "detail": "无需额外空间（硬链接可用）", "message": "" },
    "ingame": { /* 同 /api/state.ingame */ },
    "lobby":  { /* 同 /api/state.lobby  */ },
    "paths":  { /* 同 /api/state.paths  */ },
    "voiceRoot": "…"
  } }
```

### POST /api/apply
```json
{ "locale": "ja_JP",
  "modules": ["lobby_voice","ingame_voice","ingame_lang"],   // 省略=三个都做
  "restartClient": true,        // 成功后自动重启客户端 UX
  "skinsOn": false,             // 换肤插件同时开启时保持完整加载器目录
  "lobbyLang": "keep"           // "en_US" 时顺带把大厅界面切成英文
}
```
返回 `{ ok: true, task }`。任务结果结构（`GET /api/tasks/:id` 的 `result`）：
```json
{
  "ok": true, "partial": false, "restarted": true, "message": "已切换到 ja_JP，客户端正在自动重启生效…",
  "summary": { "ok": true, "partial": false, "lines": ["大厅语音 1/1","游戏内语音 180/180","游戏内语言 1/1"], "failed": [] },
  "results": [{
    "ok": true, "module": "ingame_voice", "module_name": "游戏内语音", "action": "apply",
    "planned": 180, "success": 180, "failed": 0, "missing": false,
    "reason": "", "message": "游戏内语音 180/180 已切换为 日服 (ja_JP)", "errors": [],
    "detail": { "plan": 180, "success": 180, "failed": 0 }
  }]
}
```
> `reason` 是给用户看的一句话原因，常见值：`资源缺失`、`对局中`、`游戏路径未就绪`、`替换失败 N 个：目标槽位缺失`、`已取消`。

### POST /api/restore
```json
{ "modules": ["lobby_voice","lobby_lang","ingame_voice","ingame_lang"], "restartClient": true, "skinsOn": false }
```
`modules` 只给一个时是"细分还原"；给多个/省略时走一键还原（内部按工作量汇总进度）。

### POST /api/oneclick/apply ・ POST /api/oneclick/restore
语义与上面一致，但固定"全套"：`apply` 默认三模块 + `restartClient: true`，`restore` 默认四模块。

### POST /api/update/check ・ POST /api/update/run
- `check` → `result`: `{ info: { remoteVersion, localVersion, hasUpdate, missingItems, detail, offline }, inventory: [...], voiceRoot }`
- `run` 请求体 `{ "locales": ["ja_JP","ko_KR"] }`（省略=配置里的 `supportedLocales`）
  → `result`: `{ ok, results: [{ code, ok, message, wads, lobby }], inventory, remote }`

### POST /api/plugin/install
请求 `{ "force": false }` → `{ ok, message, plugin_dir }`。把内置的 `Chosen-VoiceSync` 装到 Pengu Loader。

### POST /api/doctor → `{ ok, doctor: { app, config, paths, processes, stub, plugin, locales } }`

### GET /api/tasks ・ GET /api/tasks/:id ・ POST /api/tasks/:id/cancel
`GET /api/tasks/:id` → `{ ok, task, result, logs: ["…"] }`（`logs` 是该任务的文本日志）。
`cancel` → `{ ok: true, message: "已请求取消" }`（已在跑的文件替换不会回滚，但会停止后续项）。

## 4. GET /api/events —— 进度推送（SSE）

```
event: progress
data: {"type":"progress","id":"9f1c…","progress":{"done":37,"total":180,"percent":20.6,"current":"Ahri.zh_CN.wad.client"}}

event: log
data: {"type":"log","id":"9f1c…","line":"开始同步 ja_JP …"}

event: done
data: {"type":"done","id":"9f1c…","status":"succeeded","result":{…},"error":""}

event: state
data: {"type":"state","task":{ "id":"…","status":"running", … }}
```
- 连接后立刻收到一行注释 `: connected <ISO 时间>`；每 20 秒一个 `: ping` 心跳。
- 建议：进页面就建连，`progress` 驱动进度条，`log` 追加到日志面板，`done` 后重新拉一次 `/api/state`。

## 5. 换成你自己的 UI

三种方式，随便挑：

1. **替换内置页面**：把打包产物（`index.html` + 静态资源）放到项目根的 `web/`，刷新即可。支持前端 history 路由（未命中的 GET 页面请求会兜底到 `index.html`，`/api/*` 仍是 JSON 404）。
2. **换目录**：`config.json` → `"server": { "webDir": "dist" }`（相对项目根，或写绝对路径）。
3. **完全独立**：前端自己起服务（Vite/Electron），只把 `http://127.0.0.1:43110` 当后端调用。注意跨域已放开（`Access-Control-Allow-Origin: *`），若设置了 `token` 记得带 `X-Auth-Token`。

后端不含任何 UI 假设：不注入 HTML、不读前端状态、不要求特定框架。**只依赖本文件描述的接口形状。**
