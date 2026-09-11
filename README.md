# DSH App

自研的 DeepSeek Harness 桌面壳（Electron），**参考 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 的薄宿主架构自行实现**，与官方项目无代码关系：

- **薄 Electron 宿主**：窗口 / 托盘 / 设置 / 看门狗，全部由壳负责；
- **进程外启动 `dsh web`**：通过稳定契约（`--no-open --port`、stdout `dsh web:<url>` 就绪行、`--patch` 覆盖层）驱动官方 dsh CLI，壳与 dsh 完全解耦——升级 dsh 不影响壳；
- **看门狗 + 安全模式**：插件故障导致 dsh 启动失败时，自动解析日志 → `--dump-config` 匹配条目 → 生成 `--patch safe.yml` 禁用故障插件重启（Level 1）；无法定位时临时剥离第三方插件（Level 2，原配置自动备份），一键恢复；
- **模型网关（可视化配置）**：设置页内置网关卡——供应商表格（启用开关 / ID / baseURL / 模型数 / 优先级），行末「编辑 / 删除」，下方编辑面板仿 dsh 模型配置页布局；JSON 高级区与表格双向同步；优先级路由 + 故障切换 + SSE + 分级熔断 + 一键「写入 dsh 配置」；
- **对话输入历史**：在 Harness 对话框内按 **↑ / ↓** 查看本会话历史输入；历史**持久化到 `data\input-history.json`**（跨启动保留），按会话独立存储，Enter 发送后自动入列，不干扰 dsh 的 Enter/换行逻辑；实现在主进程（`before-input-event` 拦截），对 dsh 的 Lexical 富文本输入框兼容，不依赖页面注入时序；
- **壳级入口（托盘）**：「设置」「模型网关」「打开日志目录」等入口在**系统托盘菜单**（点击任务栏 DSH 图标弹出），可定位到设置页对应卡片；不向页面注入任何悬浮元素，不遮挡 Harness 界面；
- **图标全链一致**：托盘 / 窗口 / exe 全部使用 Electron 官方深蓝原子图标（`scripts/extract-exe-icon.mjs` 从 electron.exe 内嵌资源原样提取，与 DSH-App.exe 逐字节同源）；
- **便携数据目录**：运行数据（设置/日志/网关配置/输入历史）保存在 **exe 旁 `data\`**，随程序目录走；首次运行自动从桌面助手（`dsh-desktop\data\`）一次性迁移网关配置；
- **零原生依赖**：不需要 Visual Studio C++ 工具链（未引入 node-pty/koffi 等原生模块），`npm install` 即可。

## 环境要求

- Windows 10/11（macOS 亦兼容，未深度适配）
- Node.js ≥ 20（用于运行 dsh；Electron 自带运行时）
- dsh 本体：`npm i -g @deepseek-ai/dsh`（未安装时壳会通过 npx 自动获取）

## 快速开始

```powershell
cd dsh-app
npm install        # 安装 Electron（首次约 100MB）
npm start          # 启动壳
```

打开后即进入引导页：点击「启动 dsh 服务」→ 就绪后窗口自动加载 Harness 界面（`http://127.0.0.1:3080`，含启动 token）。关窗默认驻留托盘；托盘菜单可启动/停止/打开设置/打开日志。

## 目录结构

```
dsh-app/
├── src/
│   ├── main.js         # 主进程：装配 + IPC + 生命周期 + 单实例锁 + 输入历史（before-input-event）
│   ├── preload.js      # 渲染进程安全桥（contextIsolation；含网关 gwState/gwAction 通道）
│   ├── launcher.js     # dsh 发现/启动/停止/健康/就绪行解析（稳定契约）
│   ├── watchdog.js     # 看门狗 + 安全模式（Level 1 / Level 2 / 一键恢复）
│   ├── datadir.js      # 数据目录解析（exe 旁 data\ 优先 + 网关配置一次性迁移）
│   ├── settings.js     # 设置持久化（数据目录 settings.json）
│   ├── logger.js       # 日志落盘（app.log + web.log）
│   ├── state.js        # 壳级状态机 + 广播
│   ├── tray.js         # 系统托盘（官方 electron 图标 + 状态 tooltip）
│   ├── updater.js      # dsh 版本检查（直连 npm registry，免外部程序）
│   ├── gateway-manager.js # 模型网关托管（复用桌面助手网关运行时）
│   ├── icon.js         # 程序化图标工具（预留；实际使用官方提取资源）
│   ├── assets/         # 从 electron.exe 提取的官方图标（electron-icon.png/.ico）
│   └── gateway/        # 模型网关运行时（model-gateway.mjs，零依赖，原样分发）
├── renderer/
│   ├── status.html     # 引导/失败/安全模式页
│   └── settings.html   # 设置页（含模型网关面板）
├── scripts/
│   ├── build-portable.mjs   # 绿色免安装版（手工 asar + dist 复制）
│   ├── portable.mirror.mjs  # 单文件便携 exe（electron-builder + 镜像）
│   ├── extract-exe-icon.mjs # 从 electron.exe 提取官方内嵌图标（zero-dep PE 解析）
│   ├── dist.mirror.mjs      # NSIS 安装版 + 单文件便携（npmmirror 镜像）
│   ├── release.ps1          # 通用发布脚本（版本号从 package.json 读取）
│   └── reupload-zip.ps1     # 单资产补传（大文件上传断线重试）
└── tests/              # 6 个测试套件（unit 单测 / node tests/unit.js 可单独运行）
```

## 设置项（设置窗口）

| 项 | 说明 |
|---|---|
| 端口 | `dsh web --port`（默认 3080；改端口需重启服务） |
| 工作目录 | dsh 的启动目录（默认用户主目录） |
| 自动启动服务 | 打开应用时自动拉起 dsh |
| 开机自启 | 登录时自动运行（`--autostart`） |
| 关窗最小化到托盘 | 默认开启，关闭窗口不退出 |
| 就绪后自动打开系统浏览器 | 可选（默认关；内嵌窗口即界面，避免打扰） |
| 启动时检查更新 | 壳启动时静默对比 npm registry 的 dsh 最新版，发现新版在设置页给出升级命令（不再代装，权限与来源交给用户） |

## 模型网关（设置页内置）

设置 → 模型网关：把多个 OpenAI 兼容上游（供应商）聚合为一个统一代理（继承自 DSH 桌面助手 v1.3.5 的成熟实现 `src/gateway/model-gateway.mjs`，原样分发，可与桌面助手保持同步）：

- **统一接口**：`http://127.0.0.1:<port>/v1`（OpenAI 兼容）+ `/v1/messages`（Anthropic），统一 Key；
- 同模型多供应商按**优先级路由 + 故障自动切换**，SSE 流式透传，`/v1/models` 目录合并；
- **分级熔断**：401/403 业务拒绝立即熔断 30 分钟；网络错误/5xx 连续 3 次熔断 5 分钟；日志自动脱敏；
- 可选 `clientUA` 仿真、`/health` 健康检查；
- **「写入 dsh 配置」**：自动把网关注册为 dsh 的 `gateway` 提供商并写入统一 Key，重启 dsh web 后在模型选择器直接选用（打包版下网关运行时自动从 asar 解包到 `data\gateway\` 供外部 node 执行；**服务启动/写配置均传 `--config`/`--log` 并设 `DSH_GATEWAY_CONFIG` 环境变量，确保读取 dsh-app 自己的 `data\gateway.config.json`，不误读 `%APPDATA%\DSHDesktop` 的旧/模拟配置**）；
- 统一 Key 输入框右侧有「**复制**」按钮，一键复制到剪贴板；
- **「应用修改」与「保存并重启网关」分工**：前者只把右侧编辑面板内容写入表格/JSON 缓存（不落盘）；后者写盘并确保网关以新配置运行——**运行中自动重启、已停止则直接启动**（无需再手动点「启动网关」）；
- **启动自愈**：启动前自动清理旧实例/旧版本残留的网关进程（仅匹配命令行含 `model-gateway.mjs` 的 node 进程，不误伤其他程序），并等待端口释放后再绑定——杜绝"保存并重启"或跨实例操作时的 `EADDRINUSE` 启动失败；端口仍被非网关程序占用时给出明确提示；
- **日志实时可见**：网关内部日志（catalog 探测 / 调用 / 熔断 / 上游错误）同时输出到**设置页网关日志框与 `data\logs\gateway.log`**（`DSH_GATEWAY_VERBOSE=1`），401/余额/敏感词等上游问题可直接在界面看到原因；
- **推理档位统一翻译**：dsh 发统一推理档位（off/low/medium/high/max），网关按各上游词汇翻译后转发（各供应商可在配置里设 `reasoningEffortMap`，如 sensenova `{"max":"xhigh","off":"none"}`；未配置时原样透传，与桌面助手一致）——解决"第三方供应商 deepseek 模型无法设置/生效推理级别"问题；dsh 侧需在 settings.yaml 的模型条目声明 `reasoningEfforts` 后选择器才提供档位；
- **协议兼容（role 翻译）**：dsh 新版可能发送 `developer` 角色消息（OpenAI 协议演进），部分上游（sensenova 等）只接受 `system/assistant/user/tool`——网关转发时自动把 `developer` 合并为 `system`；
- **代理自动注入**：agentrouter/air-outer 等上游需经 clash 类代理访问——网关进程启动时自动探测系统代理/常见端口（7890 等）并注入 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`（node≥24 fetch 原生走代理），不依赖桌面环境变量；设置页「网络代理」可显式配置（启用开关 + 地址，配置优先于自动探测）；
- **零系统依赖（v1.5.17 内嵌运行时）**：基于 **Electron 44.3.0（内嵌 Node 24.20.0**，满足 dsh 全部 API 需求：zstd/stripTypeScriptTypes/HMR**）**——`DSH-App.exe` 以 `ELECTRON_RUN_AS_NODE=1` 即纯 Node 运行时 + 内嵌 npm（`resources\node_modules\npm`）——**用户机器无需安装 Node.js/npm，双击即用**：dsh 首次自动**异步**安装到便携目录 `data\node-global`（不阻塞界面）；安装/启动全程带 `--expose-internals`（dsh HMR 必需）与应用根目录 `node.exe`（硬链接，供原生依赖 postinstall 使用）；开发模式回退系统 node；
- **dsh 自动升级（v1.5.17）**：设置开启「启动时检查更新」→ 检测到新版**自动升级**（先停服防文件占用 → `npm i -g @deepseek-ai/dsh@latest`（内嵌模式装便携前缀）→ 自动重启服务）；设置页「立即升级」按钮可手动触发，进度实时写日志；**安装/升级默认走 npmmirror 镜像**（npm 默认源国内会装出残缺包——实测 zod 缺 index.js 导致启动崩；`DSH_NPM_REGISTRY` 可覆盖）；断网不阻塞；dsh 自身配置/会话在 `~/.dsh` 不受升级影响；
- **协议与仿真联动（关键）**：客户端仿真选 **Claude Code** → 网关走 **Anthropic 协议**（`/v1/messages`，x-api-key + anthropic-version + UA=claude-cli，与 Claude Code 完全同形态——**实测可避开 new-api 对 OpenAI 超长请求的内容拦截**）；选 **Codex/关闭** → **OpenAI 协议**（`/v1/chat/completions`，Bearer）。「写入 dsh 配置」按仿真写入 dsh 的 `api` 字段（claude→`anthropic-messages`、其余→`openai-completions`）与 `baseURL`（anthropic 不带 `/v1`——SDK 自拼路径，避免 `/v1/v1/messages` 双前缀 404）；模型条目自动带 `reasoningEfforts` 声明（off/low/medium/high/max，**新增模型写入时自动声明**），修改仿真后需重新「写入 dsh 配置」并重启 dsh web；
- **Anthropic 路径纯净转发（R14）**：`/v1/messages` 转发**不做 OpenAI 风格翻译**（推理翻译/role 合并仅作用于 OpenAI 路径）——否则 `thinking:{type:'disabled'}` 会被误译为 `reasoning_effort` 导致"关闭推理"失效；Anthropic 请求的密钥打码（含 content blocks）在入口完成，降敏重试兼容 blocks 结构；
- **密钥脱敏 + 自适应降敏重试（R9/R9c）**：消息中的 `github_pat_`/`sk-` 等真实 token 自动打码（保留前缀+尾 4 位）——既防密钥外泄给第三方模型，也避免上游 new-api 的"防密钥泄露"内容过滤拦截整个请求；若仍被拦（sensitive words/content-blocked），自动把 ≥32 位技术串占位符化后**重试一次**；被拦请求的结构摘要自动落盘 `data\logs\dump\`（不含明文内容）供诊断；
- **构建不销毁数据（R13）**：`build-portable.mjs` 重建输出目录前自动备份并还原 `data\`（配置/日志/设置）——修复"每次构建把用户数据清空、启动时从旧源迁移导致配置回退"的严重问题；
- **审计加固（R10-R12）**：forward 响应体单次消费（错误详情/dump 不丢）、网关启动互斥（防并发双 spawn）、「写入 dsh 配置」端口实时读配置（未运行时也正确）、诊断完整 dump 落盘前脱敏；
- **插件市场（v1.5.18，参考官方 DSH Community Market 架构）**：设置页新增「插件市场」卡片——**发现**（内置 DSH 1024Store 源，搜索/分页/详情）、**安装**（先经 npm registry 校验：同名 + 稳定版本 + 有效 `dsh.bundle.patch`，确认后执行标准 `dsh plugin add`）、**卸载**（`dsh plugin remove`）、**已安装**（读 dsh 真实 profile 状态——市场/命令行/手工安装互通，**不影响自行安装的插件**）。安全边界照搬官方：**源提供的版本不作为安装目标**（npm latest 为准）、源命令字符串一律丢弃、仅浏览型条目只展示；安装/卸载改动需重启 dsh 服务生效；`DSH_NPM_REGISTRY` 可换元数据源；
- 配置（供应商列表/优先级/Key）保存在**程序目录旁 `data\gateway.config.json`**（绿色便携，随程序目录走；不可写时才回退 `%APPDATA%\DSH-App\`；与桌面助手配置同构，可直接沿用）；
- **一次性自动迁移**：本地网关配置缺失、或仍是**模拟/示例数据**（mockA/mockB、provider-a/b）时，按优先级从桌面助手真实位置自动复制/升级（旧文件备份为 `.bak-mock`）——环境变量 `DSH_LEGACY_CONFIG` → 沿程序目录祖先链找 `<base>\dsh-desktop\data\`（真实便携配置） → `%USERPROFILE%\dsh-desktop\data\` → 旧 `%APPDATA%` 位置。来源本身是模拟数据的会被跳过；用户已修改的真实配置不会被覆盖；无导入按钮。

## 打包分发（免安装版）

```powershell
cd dsh-app
npm install
node scripts/build-portable.mjs        # 绿色免安装版 → out/DSH-App/（双击 DSH-App.exe 即用）
node scripts/portable.mirror.mjs       # 单文件便携 exe（electron-builder + npmmirror 镜像）
npm run dist                           # 完整安装包（NSIS）
```

- 绿色版无需安装、不写注册表；**运行数据（设置/日志/网关配置/输入历史）保存在程序目录旁 `data\`**——复制/移动整个目录即随身携带，删除即重置；不可写时才回退 `%APPDATA%\DSH-App\`（旧数据会自动迁移一次）；
- **图标全链一致（Electron 官方图标）**：`scripts/extract-exe-icon.mjs` 从 `node_modules\electron\dist\electron.exe` 的内嵌资源原样提取官方深蓝原子图标（`src/assets/electron-icon.png` + `.ico`），托盘 / 窗口 / 绿色版 icon 与 DSH-App.exe 完全一致；安装版/单文件便携版由 electron-builder 直接使用默认 Electron 图标，无需 rcedit 手动步骤；
- 两种打包均**不需要 Visual Studio C++ 工具链**；
- 若 GitHub 下载慢，打包工具已走 npmmirror 镜像（`portable.mirror.mjs` / `dist.mirror.mjs` 内置），也可用环境变量 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 覆盖。

> 若托盘图标仍看不到：右击任务栏空白处 →「任务栏设置」→「选择要在任务栏上显示的图标」→ 打开 DSH App 开关（Windows 11）/ 或在「通知区域」设置中把 DSH App 设为"始终显示"（Windows 10）。

## 安全模式（插件故障兜底）

dsh 的插件加载器对「任一插件 apply 失败」fail-loud（整体启动失败），坏插件会让 `dsh web` 起不来——而管理插件的 UI 又恰在服务内（死锁）。壳的看门狗在启动失败时自动处理：

1. 解析 `logs/web.log` 中的失败插件名（兼容 0.1.x 的两种报错形态）；
2. **Level 1**：`dsh --profile web --dump-config` 匹配条目 id → 生成 `safe.yml`（`disabled: true`）→ 带 `--patch` 重启；
3. **Level 2 兜底**：无法定位条目时，备份 `~/.dsh/profiles/web` 的 `package.json`/`cordis.patch.yml` → 写最小配置（仅官方 bundles）→ 重启；
4. 安全模式仍失败 → 停手并在界面提示（避免无限循环）；
5. 「退出安全模式并重启」（设置页/横幅）→ 删补丁 + 还原备份 + 正常重启。

安全模式状态持久化在 `settings.json`，崩溃/重启后仍保持（防止再次启动循环）。

### 验证安全模式（可选，2 分钟）

模拟"一个坏插件搞垮启动"的端到端验收：

1. 关闭 dsh 服务；打开 `~\.dsh\profiles\web\cordis.patch.yml`，临时追加一行：
   ```yaml
   - id: __fake_broken_plugin__
     name: 'this-package-does-not-exist-xyz'
   ```
2. 回到应用点「启动 dsh 服务」→ dsh 启动失败（插件无法解析）→ 应用应自动进入**安全模式**（标题/状态提示已禁用故障插件）、并以 `--patch safe.yml` 重启成功；
3. 正常使用确认后，在「设置 → 更新与诊断」点「退出安全模式并重启」→ 应用会删补丁并还原（此处还原的是安全模式自身的 `safe.yml`，**不会**动你第 1 步的手改条目）；
4. 手工删除第 1 步追加的测试条目，恢复原状。

> 说明：第 1 步的手改条目不会被自动清除（安全模式只管理自己生成的 `safe.yml`），验收完请手动移除。

## 升级 dsh

```powershell
npm i -g @deepseek-ai/dsh@latest     # 全局安装/升级
```

壳启动时自动采用可用版本最高者（npm 全局 / npx 缓存）；升级后重启服务即生效，壳无需任何改动。

## 发布

版本号在 `package.json` 的 `version` 字段；发布脚本自动读取（如 v1.5.9 → tag `v1.5.9`），无需改脚本：

```powershell
# 1) 编译产物（本机执行）
npm run dist:mirror              # NSIS 安装版 + 单文件便携（dist/，走 npmmirror 镜像，免 VS 工具链）
node scripts/build-portable.mjs  # 绿色版（out/DSH-App/；若旧目录被运行中实例占用自动回退，
                                 #   也可 $env:OUT_NAME='DSH-App-v1.5.9' 指定）

# 2) 发布到 GitHub（无需 git 客户端；API Token 仅在内存中）
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Token <TOKEN> [-CleanOld]
#   -CleanOld：清理仓库里 v1.x C# 桌面助手的旧文件（setup/、gateway/、DSHDesktop.cs 等，仅首次需要）
#   Release 附带：安装版 exe / 单文件便携 exe / 绿色版 zip（同名资产自动替换）

# 3) 大文件上传断线补传（可选）
powershell -ExecutionPolicy Bypass -File scripts\reupload-zip.ps1 -Token <TOKEN>
```

> 提示：PS5.1 下脚本须为 UTF-8 **带 BOM**（否则中文注释乱码）；脚本内读 `package.json` 显式指定 `-Encoding UTF8`。

## 测试

```powershell
npm test          # 6 个套件（见下），全部在临时目录内操作，不触碰真实用户数据
npm run check     # 语法检查
```

| 套件 | 覆盖 |
|---|---|
| `tests/unit.js` | 纯逻辑单测（版本比较 / 看门狗日志解析 / 网关配置校验） |
| `tests/integration.js` | 无需 Electron 的托管逻辑（网关配置读写与解包 / 安全模式文件往返 / 默认插件安装与自检） |
| `tests/market.test.js` | 插件市场条目标准化与源配置 |
| `tests/email-scrub.test.mjs` | **发布安全闸门**（真实邮箱/密钥拦截、占位符不误报、fail-closed） |
| `tests/runtime.test.js` | 运行时回归：launcher 状态机 / 看门狗终态 / 市场包名校验 / 网关管理器 / 主进程接线 / 渲染层结构 |
| `tests/gateway.test.js` | **模型网关端到端**：进程内假上游 + 真启动网关进程（鉴权 / SSE / 客户端断开取消上游 / 413 / 畸形 Host / write-dsh 的 YAML 定位） |

> 本机若未安装独立 Node.js，`node` 会解析到随应用分发的 `DSH-App.exe`（Electron 的
> `ELECTRON_RUN_AS_NODE` 模式）——测试已适配（`process.noAsar`、`process.resourcesPath`
> 只读、子进程管道 stdio 受限等）。

## 已知边界

- 未做 macOS 深度适配（架构预留，`tray`/`updater` 均为跨平台 API，需真机验证）；
- 「终端」未内置（官方项目的 node-pty 需要原生编译，与"免 VS 工具链"约束冲突）；需要终端时请用系统终端；
- 与 dsh 的交互面严格限定在稳定契约内，不读取 dsh 内部文件（`lib/*.js` 等）。

## License

MIT