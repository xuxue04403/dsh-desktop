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
│   ├── logger.js       # 日志落盘（app.log + web.log，**两者都带时间戳**）
│   ├── state.js        # 壳级状态机 + 广播
│   ├── tray.js         # 系统托盘（官方 electron 图标 + 状态 tooltip）
│   ├── updater.js      # dsh 版本检查（直连 npm registry，免外部程序）
│   ├── gateway-manager.js # 模型网关托管（复用桌面助手网关运行时）
│   ├── plugin-snapshot.js # 迁移快照（换机后自动装回用户插件与 dsh 配置）
│   ├── machine-adapt.js   # 换机首启适配（清写死的凭据路径 / 按区域启停 WorkBuddy / 关不可达代理）
│   ├── icon.js         # 程序化图标工具（预留；实际使用官方提取资源）
│   ├── assets/         # 从 electron.exe 提取的官方图标（electron-icon.png/.ico）
│   └── gateway/        # 模型网关运行时（model-gateway.mjs，零依赖，原样分发）
├── renderer/
│   ├── status.html     # 引导/失败/安全模式页
│   └── settings.html   # 设置页（含模型网关面板）
├── scripts/
│   ├── build-portable.mjs   # 绿色目录版（手工 asar + dist 复制）
│   ├── build-uat.mjs        # 构建到 out/DSH-App-UAT（验证环境，保留其 data\）
│   ├── portable.mirror.mjs  # 单文件便携 exe（electron-builder + 镜像）
│   ├── extract-exe-icon.mjs # 从 electron.exe 提取官方内嵌图标（zero-dep PE 解析）
│   ├── dist.mirror.mjs      # NSIS 安装版 + 单文件便携（npmmirror 镜像）
│   ├── publish.mjs          # 发布到 GitHub：安全闸门 + 绿色 zip + 传源码 + 传资产 + 校验
│   ├── verify-workbuddy.mjs # WorkBuddy 接入离线全链路验证（配套 mock-workbuddy.mjs）
│   ├── probe-workbuddy-net.mjs / probe-opencode-zen.mjs # 上游连通性/端点排障探针
│   ├── fetch-npm.mjs         # v1.9.0：取一份自包含 npm 到 out\_npm（内嵌 npm 的唯一来源，构建前置）
│   ├── release.ps1          # 旧版 PowerShell 发布脚本（语义已对齐 publish.mjs）
│   └── reupload-zip.ps1     # 单资产补传（大文件上传断线重试）
└── tests/              # 7 个测试套件、290 个用例（node tests/unit.js 可单独运行）
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
- **选路顺序（2026-09-17 起）= 先 `priority` 升序（数值小者先试），同一优先级内按配置数组顺序**；配置页 ▲▼ 只调整同级内的先后，**不改写** priority（行内徽标显示 `P<优先级> #<列表位置>`）。层级优先于优先级：**在配置里声明承载该模型的家**永远排在"一个模型都没配、只能靠上游目录兜底"的家之前（2026-09-15 误路由事故的修复规则）。**代码里没有任何按供应商名写死的优先级**（含 workbuddy）——"国内兜底"就是配置里把国内可达的家设成较小的 `priority`（当前部署：sensenova=1、amd=1、workbuddy=2、境外各家=5、windhub=10），想改顺序直接在配置页改 priority 即可；
- 同模型多供应商**故障自动切换**，SSE 流式透传，`/v1/models` 目录合并；每次请求写一行 `[route] <模型>: N 个候选｜各家判定`，并记 `[call] … via=provider#账户`，排查"为什么走了这家/哪个 Key"直接看日志；
- **分级熔断（2026-09-17 加固，2026-09-18 细化为账户级/供应商级）**：
  - **裸 401/403（未授权 / 该 Key 被禁用 / 令牌分组被禁）→ 账户级失败**：配了多把 Key 时**按 Key 轮换**（该 Key `session` 冷却 60 分钟），**不熔断整家**——旧实现把它当"供应商级 403"直接熔断 30 分钟，用户特意配的多把 Key 被第一把连坐（实测 nvidia 4 把 Key 全废）；只有**该家所有 Key 都不可用**才判该家不可用、长熔断 30 分钟。**例外：内容/敏感词拦截类 403**（换 Key 无用，属请求本身的问题）不算账户故障；429 限流 → 账户级 `rate` 冷却 90 秒；
  - **402 额度/预算耗尽**（`Budget pool quota has been exhausted` 等）→ 首次即**长熔断 30 分钟**（不会自愈的确定性状态，不再按"临时"每 90 秒重撞）；
  - 网络错误/5xx → 连续 3 次后熔断，并按连续开闸次数**指数退避** 90s → 3m → 6m → 12m → 24m → 30m（成功后清零）——修"坏家每 90 秒被重探一次"；
  - **半开探测用短超时**（默认 10 秒，可用 `DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS` 调整）：冷却到点的那次探测不再让用户请求白等 60 秒（实测某次 78.5s，现在最多 ~10s 就切到健康家）；
  - 冷却到点必然放行一次探测、成功即恢复 → **熔断不会永久卡死**；日志自动脱敏；
  - **探测超时的例外（2026-09-22 实测事故修复）**：供应商**显式声明** `timeoutMs` 时，半开探测也按它执行，不再被压到 10 秒——旧实现用 `Math.min(base, PROBE)` 一刀切，于是"首字节稳定 >10s"的家**探测必然超时 → 熔断重新 open → 退避递增 → 永远无法恢复**，配了 `timeoutMs` 也没用。实测 amd 的 `DeepSeek-V4.1-Flash` 首字节 13.7–15.5s（同家 `DeepSeek-V4-Flash` 只要 0.7–1.1s），导致每个请求都 `skip amd (breaker open)` 落到备用家；现已给 amd 配 `timeoutMs: 20000`。**为什么不是更大**：实测该上游对该模型还有一种「既不报错也不出首字节地挂住」的形态（直连观测到 50s 无响应），超时设多少就要白等多少——20s 覆盖成功案例（最慢 15.5s）又把最坏等待砍半；若它挂住，用户等 20s 而非 45s 就切到备用家；
- 可选 `clientUA` 仿真、`/health` 健康检查（含账户池与代理状态）；
- **WorkBuddy 内置模型接入（v1.8.1）**：WorkBuddy 只提供 OpenAI 线协议，网关自动把 dsh 的 Anthropic 请求翻译成 OpenAI、再把响应（**含 SSE 流**）翻回 Anthropic 事件序列；按本机安装版本合成**桌面客户端身份 UA**（`WorkBuddy/<app> … CLI/<cli>`，从 `resources\install-manifest.json` 与内置 CLI 的 `package.json` 读取）——用 CLI 形态 UA 调 chat 会被上游判"参数不符合模型要求"；**chat 还必须带使用端身份三头** `X-IDE-Type: WorkBuddy` / `X-IDE-Name: WorkBuddy` / `X-IDE-Version: <本机桌面版本>`（2026-09-18 用户实测发现：只发 UA 时腾讯控制台「积分消耗明细 → 使用端」把网关调用记成 `-`；官方桌面端启动内置 CLI 时用 `CLIENT_INFO_IDE_TYPE/PLATFORM = "WorkBuddy"`、`CLIENT_INFO_PLATFORM_VERSION = <桌面版本>` 注入，CLI 再写成这三个头）；凭据**只读**复用 WorkBuddy 桌面 App 的登录信息并在到期前自动刷新（刷新结果写在 `data\gateway\workbuddy-auth\`，绝不改写 App 自己的文件），路径免配置自动发现（`WORKBUDDY_AUTH_FILE` / `WORKBUDDY_APP_DIR` 可指定）。离线回归：`node scripts/verify-workbuddy.mjs`（配套模拟器 `scripts/mock-workbuddy.mjs`，**不需要安装 WorkBuddy**）；
- **WorkBuddy 国内版 / 国际版（2026-09-20 按参照实现核对）**：两个区域是**独立供应商**——国内版 `workbuddy`（`baseURL: https://copilot.tencent.com/v2`）、国际版 WorkBuddy AI `workbuddy-global`（`baseURL: https://www.workbuddy.ai/v2`，配置里默认 `enabled: false`，换机/新电脑时启用它并停用国内版即可）。端点常量与区域判定均按参照实现 [`corrinehu/dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) 核对（其 `GLOBAL_BASE = https://www.workbuddy.ai` + `/v2/chat/completions`；`regionOf()` 只认 `workbuddy.ai` → 国际版）。凭据文件名同样按区域区分：国内版 `workbuddy-desktop.info` / 国际版 `workbuddy-desktop-ai.info`（同一 `CodeBuddyExtension\Data\Public\auth\` 目录，只差文件名），环境变量 `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE`；`accounts: [{ id }]` 留空路径即按平台默认位置自动发现，**换机不要写死绝对路径**。产品名与身份头随之切换：国际版 chat UA 用 `WorkBuddy AI/<v>`（`WorkBuddy/<v> WorkBuddy AI/<v> CLI/<cli>`），`Origin`/`Referer` 用 `https://www.workbuddy.ai`；`X-Product: SaaS` 两区域一致；
  - **区域守卫（安全红线）**：两个区域的凭据**互不通用**，配错就会把一国账号的 token 发到另一国端点（实测国际端点返回 apisix `401 Authorization Required`）。网关在**发请求前**校验"凭据域 ↔ 供应商区域"，不匹配时直接拒绝并指明该改哪个文件/环境变量，绝不试探性发送；供应商区域取 `region` 字段（显式）→ baseURL 主机名（`*.workbuddy.ai` / `copilot.tencent.com` / `*.codebuddy.cn`）→ 都判断不出（自建中转、测试上游）则**不拦截**，避免误伤；
  - **换机到只装国际版的新电脑（v1.8.3 起已自动，无需手工）**：以前要人工把预置的 `data\gateway.config.intl.json` 改名为 `gateway.config.json` 覆盖。现在由**首次启动的换机适配**自动完成（见下条「换机首启适配」）——它会按新机实际登录的凭据识别区域，自动启用 `workbuddy-global` 并停用国内版，同时清掉写死的凭据路径与不可达的本地代理。目录内的 `gateway.config.intl.json` 仍保留，作为**手工兜底**（只含 `workbuddy-global`：`baseURL: https://www.workbuddy.ai/v2`、`accounts: [{ id: "acct1" }]` 免路径、**不含任何其它供应商的 Key**、不含代理设置）；前置仍是该机已安装并登录 WorkBuddy AI 桌面 App。
  - **换机首启适配（v1.8.3 新增 `src/machine-adapt.js`）**：绿色目录会把 `data\gateway.config.json` 带到新电脑，但里面有三处**只对原机器成立**，以前必须人工改。现在首次在新机器启动时自动处理（幂等：按机器指纹，只做一次；正常启动只是一次小文件读取）——
    · **写死的凭据路径**：`accounts[].authFile` 指向本机不存在的路径（别的电脑/别的用户名）→ 清空该字段，交回平台默认位置自动发现；
    · **WorkBuddy 区域**：按新机**实际登录的凭据**判定区域（权威判据是凭据文件里的 `domain`，`workbuddy.ai` = 国际版；**不看文件名**——"国际版文件里其实是国内账号"只看文件名会判错），启用对应那家、停用另一家；两区域都没登录则把这些家停用，避免启动即报凭据错误；
    · **本地代理**：`proxy.url` 指向原机器的本地代理（如 `127.0.0.1:7890`）且新机探测不可达 → 自动关闭并记日志（否则境外供应商全部连不上，旧行为还会把网络错记在上游账号头上）；
    · **边界**：只改上述"机器相关"字段，**绝不触碰** `apiKey` / `apiKeys` / 模型映射 / 优先级；改写前留 `.bak-machineadapt-<时间戳>` 备份；任何异常都**不阻断启动**，只记一行日志。想强制重跑，删 `data\machine-adapt.applied.json` 再启动；
  - **换机前清理（密钥卫生）**：`data\` 下历史 `.bak-*` 备份含**明文 API Key**，复制目录给他人/上传前必须先删。2026-09-20 已把本机 12 个备份移出绿色目录（归档在 `D:\IDE\dsh\_gateway-config-backups-20260920\`），目录内现只剩 `gateway.config.json` 一份（仍是你的真实配置，**换机时用 `gateway.config.intl.json` 覆盖它**）；
- **身份仿真只作用于 WorkBuddy（2026-09-18 与用户确认）**：桌面 UA + `X-IDE-*` 三头只在 `auth: "workbuddy"` 的供应商上生效（代码里唯一的注入点就在该分支）；其余所有供应商一律按网关配置的 `clientProfile`（claude / codex / **cline** / 自定义 `clientUA`）或供应商自带 `headers.User-Agent` 仿真，绝不会混入 WorkBuddy 身份——`tests/gateway.test.js` 的「身份仿真边界」用例逐条守住这条边界；
- **Cline 客户端仿真（2026-09-23）**：新增 `clientProfile: "cline"` 档，发送 Cline 官方 SDK 形态的请求头（`User-Agent: Cline/3.0.47`、`X-CLIENT-TYPE: cline-sdk`、`X-CORE-VERSION` 等 9 个头）。上游 `api.cline.bot` 只对"Cline 产品面"开放：**完全裸头**会被拒 `403 … only available via Cline product surfaces`；实测最小充分集是单个 `X-CLIENT-TYPE: cline-sdk`（UA 内容不校验但**存在性必需**，版本号不是硬门禁）。仿真档支持**逐家覆盖**：供应商条目里的 `clientProfile` 优先于全局；未声明时按 `baseURL` 主机名自动推断（`*.cline.bot` → cline 仿真），因此接入 Cline 时**不必手写那 9 个头**。注意顶层 `clientProfile` 同时决定 dsh 的 `api` 协议（claude → anthropic-messages），只想改某家头形态时应写在供应商条目里；
- **思维链字段名兼容（2026-09-23，审计 D5）**：旧实现只认 `reasoning_content`（DeepSeek 系写法），而 OpenRouter 系（含 Cline）用 `reasoning` / `reasoning_details` —— 只认一个字段名的后果是**思维链被静默丢弃**（不报错、不告警，客户端只看到最终答案，最难排查）。现在统一走 `reasoningTextOf()`，按 `reasoning_content` → `reasoning` → `reasoning_details` 顺序取**第一个非空者**（不相加，避免同一分片重复两遍），三条路径（直通聚合 / 非流式翻译 / SSE 翻译）全部覆盖；
- **账户池 / 同一供应商多把 Key（v1.8.2）**：供应商可配 `apiKeys: ["sk-a", "sk-b"]`（设置页「API Key」框**每行一把，第 1 行为主 Key**），网关把它映射成**账户池轮换**——某把额度耗尽（402/积分不足）、密钥失效/未授权（裸 401/403）、限流（429）时各自按类型冷却（30 分钟 / 60 分钟 / 90 秒）并**自动换下一把**，全部不可用才交给下一家供应商；**账户级失败不计供应商熔断**（否则第一次额度耗尽就把整家熔断，换 Key 的重试会被熔断挡在门外）。`GET /health` 的 `accounts` 逐把列出状态与剩余冷却时间，日志用 `via=provider#key2` 标注实际使用的 Key。等价写法：`accounts: [{ id, apiKey | authFile }]`（`authFile` 供 WorkBuddy 凭据用）。**限流（429）的冷却粒度是「供应商+账户+模型」（2026-09-22 实测修复）**：上游限流常是**模型级**的（实测 amd `Model 'DeepSeek-V4.1-Flash' is at its concurrency limit (32)`），而多把 Key 打的是同一个模型、共享该上限，换 Key 无用；旧实现按账户级冷却，于是某模型的一次 429 把该 Key 上**本来正常的其它模型**也连坐 90 秒。现在 `/health` 里账户级状态保持 `ok`，模型级冷却单独列为 `modelScoped: true` 条目并带 `model` 字段；额度耗尽（402）/登录失效仍是账户级（整把 Key 不可用）；
- **thinking 回传需求"学习"（v1.8.2）**：部分上游（air-outer / agentrouter）对"带 tool_use 但缺 thinking 块"的 assistant 轮回 400 或笼统 500；网关补空占位块重试一次，并**记住该家的需求**——后续请求首次就补齐，不再白打一次（省掉重复的上游失败与计费）；
- **上游"不支持 thinking"的相反形态（v1.8.2）**：客户端会按模型声明的推理档位带顶层 `thinking` 参数，而有的上游模型不支持（实测 amd/GLM-5.3-Flash → `HTTP 200 + SSE 首事件 error：`"thinking" is not supported…``；也有直接回 400 的）。网关命中该错误时**去掉顶层 `thinking` 参数重试一次**，并记住该家——后续请求首次就剥掉，不再白失败一轮；不想等学习或要强制某家永不发 thinking，可写 `quirks: ["drop-thinking"]`。注意粒度是**按供应商**（该家任一模型被拒后，该家全部请求都会剥掉 thinking）；
- **同一逻辑名映射多个上游 ID 时按图片能力选择（v1.8.2）**：一个逻辑名可以同时映射"普通变体"与"vision 变体"（如 amd 的 `DeepSeek-V4-Flash` / `DeepSeek-V4-Flash-Vision-Exp`）——**带图片的请求自动走声明了 `vision: true` 的那条**，纯文本仍走第一条，避免把图片发给不支持图片的变体（配置里两条顺序无所谓）；带图片的请求还会**只保留声明了图片能力的候选家**（其余家会收到它们处理不了的图片）；
- **注意"历史图片"会持续影响选路（2026-09-18 排查结论）**：客户端**每轮都重发完整历史**，所以会话里贴过一次截图后，之后每一轮（哪怕本轮纯文字）请求体里都带着那张图 → 多模态过滤会一直生效、纯文本家一直被跳过。日志现已区分来源：`请求含图片（本轮 N 张 / 历史 M 张）→ 跳过未声明图片能力的 K 家`；想让选路恢复全量候选，开新会话（或让历史里不再带图）即可。另外模型声明了 `input: [text, image]`（见「写入 dsh 配置」）时 harness 就**不再**过滤历史图片——切回纯文本模型时 harness 会自行丢弃图片并提示"当前模型不支持图片"；
- **配置页（v1.8.2）**：左侧**分区导航**（服务 / 窗口 / 模型网关 / 插件市场 / 更新与诊断），点击平滑定位、滚动自动高亮，窄窗口或高缩放时自动变成顶部药丸标签条；供应商「API Key」支持多把（每行一把），它与「统一 Key」都带 **👁 明文显示**开关；
- **「写入 dsh 配置」**：自动把网关注册为 dsh 的 `gateway` 提供商并写入统一 Key，重启 dsh web 后在模型选择器直接选用（打包版下网关运行时自动从 asar 解包到 `data\gateway\` 供外部 node 执行；**服务启动/写配置均传 `--config`/`--log` 并设 `DSH_GATEWAY_CONFIG` 环境变量，确保读取 dsh-app 自己的 `data\gateway.config.json`，不误读 `%APPDATA%\DSHDesktop` 的旧/模拟配置**）；
- 统一 Key 输入框右侧有「**复制**」按钮，一键复制到剪贴板；
- **「应用修改」与「保存并重启网关」分工**：前者只把右侧编辑面板内容写入表格/JSON 缓存（不落盘）；后者写盘并确保网关以新配置运行——**运行中自动重启、已停止则直接启动**（无需再手动点「启动网关」）；
- **启动自愈**：启动前自动清理旧实例/旧版本残留的网关进程（仅匹配命令行含 `model-gateway.mjs` 的 node 进程，不误伤其他程序），并等待端口释放后再绑定——杜绝"保存并重启"或跨实例操作时的 `EADDRINUSE` 启动失败；端口仍被非网关程序占用时给出明确提示；
- **日志实时可见**：网关内部日志（catalog 探测 / 调用 / 熔断 / 上游错误）同时输出到**设置页网关日志框与 `data\logs\gateway.log`**（`DSH_GATEWAY_VERBOSE=1`），401/余额/敏感词等上游问题可直接在界面看到原因；
- **推理档位统一翻译**：dsh 发统一推理档位（off/low/medium/high/max），网关按各上游词汇翻译后转发（各供应商可在配置里设 `reasoningEffortMap`，如 sensenova `{"max":"xhigh","off":"none"}`；未配置时原样透传，与桌面助手一致）——解决"第三方供应商 deepseek 模型无法设置/生效推理级别"问题；dsh 侧需在 settings.yaml 的模型条目声明 `reasoningEfforts` 后选择器才提供档位；
- **协议兼容（role 翻译）**：dsh 新版可能发送 `developer` 角色消息（OpenAI 协议演进），部分上游（sensenova 等）只接受 `system/assistant/user/tool`——网关转发时自动把 `developer` 合并为 `system`；
- **代理自动注入**：agentrouter/air-outer 等上游需经 clash 类代理访问——网关进程启动时自动探测系统代理/常见端口（7890 等）并注入 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`（node≥24 fetch 原生走代理），不依赖桌面环境变量；设置页「网络代理」可显式配置（启用开关 + 地址，配置优先于自动探测）；显式关闭（`proxy.enabled: false`）时会**清掉继承来的代理变量**，确保"配了直连就是直连"；
- **直连清单 / 代理事故修复（v1.8.2）**：`NODE_USE_ENV_PROXY=1` 时 Node 会把**连 127.0.0.1 的请求也交给代理**——clash 一停，网关连自己的 `/health` 自检都连不上，连续 3 次失败就**让健康进程自杀**（宿主当崩溃重启），同时所有上游请求秒回 ECONNREFUSED，而熔断器还把锅记在上游账号上。现在：
  - **回环恒直连**：`127.0.0.1` / `localhost` / `::1` 永远在 `NO_PROXY` 里（本机自检绝不依赖代理）；
  - **国内端点默认直连**：`copilot.tencent.com`、`*.workbuddy.cn`（实测直连 133ms 可达）；设置页新增「**直连域名**」输入框（支持裸后缀，如 `tencent.com`），落盘为 `proxy.noProxy: [...]`；
  - 供应商条目可写 `"proxy": false`（该家直连）；`proxy.forceProxy: [...]` 反向把域名强制走代理（覆盖内置直连清单）；部署建议：**国内可达的家都写 `"proxy": false`**——clash 挂掉时国内兜底仍然可用（2026-09-18 事故：三家境外上游 5.0s ECONNRESET，排查时先要区分"网关没走代理 / 代理节点坏了 / 上游挂了"：跑 `node scripts/probe-upstream-net.mjs`，逐个域名对比直连与走代理的结果，401/403/404 都算链路通）；
  - 进程内自检改为**裸 socket 发最小 HTTP 请求**（不经过任何代理层），且每次自检**最多记一次失败**（旧实现一次超时被记两笔，两分钟就能凑够 3 次）并写明失败原因与耗时；
  - 上游网络错若发生在"本进程走代理、且该域名不在直连清单"时，日志会直接点名**"代理未运行（Clash 退出/重启中）"**，不再冤给上游；`/health` 也暴露 `proxy`（url / noProxy / envProxy）；
- **零系统依赖（v1.5.17 内嵌运行时）**：基于 **Electron 44.3.0（内嵌 Node 24.20.0**，满足 dsh 全部 API 需求：zstd/stripTypeScriptTypes/HMR**）**——`DSH-App.exe` 以 `ELECTRON_RUN_AS_NODE=1` 即纯 Node 运行时 + 内嵌 npm（`resources\node_modules\npm`）——**用户机器无需安装 Node.js/npm，双击即用**：dsh 首次自动**异步**安装到便携目录 `data\node-global`（不阻塞界面）；安装/启动全程带 `--expose-internals`（dsh HMR 必需）与应用根目录 `node.exe`（硬链接，供原生依赖 postinstall 使用）；开发模式回退系统 node；
- **dsh 自动升级（v1.5.17）**：设置开启「启动时检查更新」→ 检测到新版**自动升级**（先停服防文件占用 → `npm i -g @deepseek-ai/dsh@latest`（内嵌模式装便携前缀）→ 自动重启服务）；设置页「立即升级」按钮可手动触发，进度实时写日志；**安装/升级默认走 npmmirror 镜像**（npm 默认源国内会装出残缺包——实测 zod 缺 index.js 导致启动崩；`DSH_NPM_REGISTRY` 可覆盖）；断网不阻塞；dsh 自身配置/会话在 `~/.dsh` 不受升级影响；
- **协议与仿真联动（关键）**：客户端仿真选 **Claude Code** → 网关走 **Anthropic 协议**（`/v1/messages`，x-api-key + anthropic-version + UA=claude-cli，与 Claude Code 完全同形态——**实测可避开 new-api 对 OpenAI 超长请求的内容拦截**）；选 **Codex/关闭** → **OpenAI 协议**（`/v1/chat/completions`，Bearer）。「写入 dsh 配置」按仿真写入 dsh 的 `api` 字段（claude→`anthropic-messages`、其余→`openai-completions`）与 `baseURL`（anthropic 不带 `/v1`——SDK 自拼路径，避免 `/v1/v1/messages` 双前缀 404）；模型条目自动带 `reasoningEfforts` 声明（off/low/medium/high/max，**新增模型写入时自动声明**），修改仿真后需重新「写入 dsh 配置」并重启 dsh web；
- **Anthropic 路径纯净转发（R14）**：`/v1/messages` 转发**不做 OpenAI 风格翻译**（推理翻译/role 合并仅作用于 OpenAI 路径）——否则 `thinking:{type:'disabled'}` 会被误译为 `reasoning_effort` 导致"关闭推理"失效；Anthropic 请求的密钥打码（含 content blocks）在入口完成，降敏重试兼容 blocks 结构；
- **密钥脱敏 + 自适应降敏重试（R9/R9c）**：消息中的 `github_pat_`/`sk-` 等真实 token 自动打码（保留前缀+尾 4 位）——既防密钥外泄给第三方模型，也避免上游 new-api 的"防密钥泄露"内容过滤拦截整个请求；若仍被拦（sensitive words/content-blocked），自动把 ≥32 位技术串占位符化后**重试一次**；被拦请求的结构摘要自动落盘 `data\logs\dump\`（不含明文内容）供诊断；
- **构建不销毁数据（R13）**：`build-portable.mjs` 重建输出目录前自动备份并还原 `data\`（配置/日志/设置）——修复"每次构建把用户数据清空、启动时从旧源迁移导致配置回退"的严重问题；
- **审计加固（R10-R12）**：forward 响应体单次消费（错误详情/dump 不丢）、网关启动互斥（防并发双 spawn）、「写入 dsh 配置」端口实时读配置（未运行时也正确）、诊断完整 dump 落盘前脱敏；
- **插件市场（v1.5.18，参考官方 DSH Community Market 架构）**：设置页新增「插件市场」卡片——**发现**（内置 DSH 1024Store 源，搜索/分页/详情）、**安装**（先经 npm registry 校验：同名 + 稳定版本 + 有效 `dsh.bundle.patch`，确认后执行标准 `dsh plugin add`）、**卸载**（`dsh plugin remove`）、**已安装**（读 dsh 真实 profile 状态——市场/命令行/手工安装互通，**不影响自行安装的插件**）。安全边界照搬官方：**源提供的版本不作为安装目标**（npm latest 为准）、源命令字符串一律丢弃、仅浏览型条目只展示；安装/卸载改动需重启 dsh 服务生效；`DSH_NPM_REGISTRY` 可换元数据源；
- 配置（供应商列表/优先级/Key/直连域名）保存在**程序目录旁 `data\gateway.config.json`**（绿色便携，随程序目录走；不可写时才回退 `%APPDATA%\DSH-App\`；与桌面助手配置同构，可直接沿用）。设置页覆盖的字段：顺序（▲▼）、`priority`、`apiKey`/`apiKeys`、`models`（含 `vision`/`contextWindow`/`maxTokens`）、启用开关、`protocol`/`auth`/`accounts`/`quirks`/`headers`（在 JSON 里编辑，编辑器顶部显示摘要）；`proxy.noProxy` 对应设置页的「直连域名」；
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

### 换新电脑的一键复用包（v1.8.3）

把当前环境（含你已配好的供应商与 Key）打成一个可整包搬到新电脑的 zip：

```powershell
# 1) 构建到版本目录（不要覆盖正在运行的 out\DSH-App——会被自动回退，见下方「乒乓构建规则」）
$env:OUT_NAME='DSH-App-v1.8.3'; node scripts/build-portable.mjs

# 2) 把权威 data\ 复制进去（排除启动即再生的 logs/gateway/broker/market）
#    注意：data\ 含明文 Key，此包仅供自己换机使用

# 3) 精简 + 换机清洗 + 三重校验 + 打 zip
node scripts/pack-slim.mjs --src out\DSH-App-v1.8.3
```

产物：`dist\DSHApp-<version>-Slim-WithData.zip`（1.8.3 实测 620 MB → 186 MB 级）。

`pack-slim.mjs` 的**换机清洗**（在精简基础上额外做）：
- 删除 `data\machine-adapt.applied.json` —— 留着会让**恰好同名同用户**的新机跳过换机适配；
- `data\broker`、`data\market`（内含写死绿目录绝对路径的 `launch-dsh.cmd` / `pnpm.cmd`）随"启动即再生"目录一并删除，新机启动时按自己的路径重新生成；
- 删除残留的 `*.tmp` 半写文件。

写死的凭据路径、WorkBuddy 区域、本地代理**不在这里改**——由应用首次启动的换机适配处理（见「模型网关」章节），这样包本身保持原样、适配逻辑只有一处。

zip 内附 `换新电脑说明.txt`（三步上手 + 自动适配说明 + 需人工确认项 + 密钥安全提示）。

### 乒乓构建规则（主目录 ↔ UAT，2026-09-18 与用户确认）

两个绿色目录轮流当"当前使用的那一个"，**构建永远先构建不用的那一个**，验证通过后再构建在用的那一个：

1. 当前在用 `out\DSH-App`（主目录）→ 改完所有 bug、测试全绿后，用最新代码构建 `out\DSH-App-UAT`（`node scripts/build-uat.mjs`，会保留 UAT 自己的 `data\`）；
2. 退出正在运行的主目录实例 → 启动 UAT 验证（UAT 用自己的 `data\`，两个目录端口相同，**不要同时开**）；
3. 验证通过后（此时主目录已退出、`resources\app.asar` 不再被占用）再构建最新主目录：`node scripts/build-portable.mjs`；
4. 若当前在用 UAT，则顺序反过来。

**为什么不能在运行中构建**：`build-portable.mjs` 检测到目标目录被运行中的实例占用时会**自动回退**到带版本号的目录（`out\DSH-App-v<version>`），主目录不会被更新——历史上那些几十上百 MB 的 `DSH-App-v*` 目录就是这么来的；同理，运行中的 asar 不应被覆盖（Electron 懒加载 asar 内文件，替换后可能直接崩）。网关运行时（`data\gateway\model-gateway.mjs`）是 asar 的**执行副本，每次应用启动都会从 asar 重新复制**——只热更新运行时文件的话，本次进程有效，下次启动即被 asar 覆盖。

> 若托盘图标仍看不到：右击任务栏空白处 →「任务栏设置」→「选择要在任务栏上显示的图标」→ 打开 DSH App 开关（Windows 11）/ 或在「通知区域」设置中把 DSH App 设为"始终显示"（Windows 10）。

## v1.9.0：界面加载、退出确认、崩溃报告、迁移自检

本节四项改动都源自对**官方 DeepSeek Harness Desktop**（仓库内 `apps/desktop`，包名 `@deepseek-ai/dsh-desktop`）的代码研读——借鉴其机制，**但不替换本项目的架构**。原因逐项写在下面。

### 主界面不再以 URL 携带启动令牌（`src/web-auth.js`）

此前主窗口是 `loadURL(authUrl)`，`?token=…` 会进入渲染层的 `location`、导航历史，以及页面内第三方插件的客户端脚本。现在先用令牌换会话 cookie，再由 Electron 的 session 持有，主窗口加载**不含令牌**的干净地址。dsh 的令牌换发本就为此设计：实测 `GET /?token=…` 返回 `303 + set-cookie: dsh-auth-…`，不带 cookie 访问首页为 401。

**为什么没照搬官方桌面版的 `dsh-app://` 自定义协议**：官方把 Web 前端打包进自己的 asar，页面 origin 可以换成隔离协议；本项目用的是**系统 dsh 运行时页面**，实测其客户端这样推导 WebSocket 端点（`@deepseek-ai/dsh-api-gateway` 客户端 bundle）：

```js
function remoteStreamUrl() {
  const base = location?.origin !== void 0 && location.origin !== "null"
    ? location.origin : INTERNAL_BASE;          // INTERNAL_BASE = "http://dsh.internal"
  const url = new URL("/api/remote.mux", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
```

一旦 origin 变成 `dsh-app://app`，端点会解析成 `ws://app/api/remote.mux` 而**必然失败**；同一 bundle 另有 9 处用 `location.origin` 推导 API base，且**不存在任何注入覆盖通道**（已搜 `streamBaseUrl` / `__DSH_STREAM*` / `connectionBase` / `wsBase` 等覆盖键，全部零命中）。因此改用等价且零侵入的 cookie 引导：**origin 不变，WebSocket 与相对路径 API 全部照旧**。换发每次 dsh 就绪只做一次（cookie 绑定该次启动的 authority），任何一步失败都自动回退到带令牌的 URL——界面一定打得开。

实现上的两个坑（都实测踩到）：

1. **必须用全局 `fetch`，不能用 `session.fetch`**。Electron 的 `session.fetch` 对 `redirect: 'manual'` 不返回 3xx，而是直接以 `Redirect was cancelled` 拒绝（2026-09-25 实际发生，日志表现为"cookie 引导未生效……回退为带令牌的 URL"）。现在用全局 fetch 取 `303` + `Set-Cookie`，再用 `session.cookies.set` **显式写入** jar（`parseSetCookie` 解析各属性；`Domain` 刻意不传——dsh 签的是 host-only cookie；`SameSite=None` 需转成 Electron 认的 `no_restriction`）。
2. cookie 值里绑定了**权威**（`authority: "<host>:<port>"`），端口一变即失效，所以每次 dsh 就绪都要重换。

### 退出前任务确认（`src/quit-guard.js`）

官方桌面版能直接问 Host「这次退出会打断什么」（私有 IPC，2 秒不应答按有任务算）。本项目与 dsh 之间只有 stdout 就绪行 + HTTP 两个稳定契约，没有这条通道，因此改用**旁路可观测信号**：

| 信号 | 依据 | 覆盖的场景 |
|---|---|---|
| dsh 会话状态写入 | `$DSH_HOME/storages/session_projcache/sessions/*.json` 的 mtime（实测与活动严格同步；145 个文件全量 stat 约 12ms） | 工具调用、消息、会话状态变更 |
| 模型网关流量 | `GatewayManager.pushLog` 是全部 stdout/stderr 的唯一汇聚点 | 「模型正在思考、会话尚未落盘」的空档 |

窗口 20 秒（闭区间）。判定是**概率性**的、不是权威答案——对话框措辞如实说明这一点，默认按钮为「退出」（与官方一致），可在设置里关闭（`confirmQuitWhenBusy`）。

### 崩溃报告（`src/crash-report.js`）

四类现场各自固化一份 `logs\crash-<时间>-<来源>.log`：

| 来源 | 触发 |
|---|---|
| `main` | 主进程未捕获异常 / 未处理的 Promise 拒绝 |
| `renderer` | 渲染进程非正常退出（`clean-exit` 不计） |
| `web` | dsh 服务**非用户主动**退出（含启动失败与就绪后崩溃） |
| `gateway` | 网关反复异常退出、已放弃自愈（单次自愈重启不记） |

保留最近 10 份；同毫秒内的多次记录**加序号而不覆盖**（覆盖会丢掉最原始那次故障）。因为这份文件会被用户主动拷去另一台机器排查，落盘前对疑似密钥做**基础脱敏**（`sk-`/`sk_`、`Bearer`/`Basic`、`apiKey|token|secret|password` 赋值形态、`DSH_*_KEY` 环境变量形态、32 位以上连续 hex）。`app.log` 仍是滚动流水，崩溃报告是它的补充而非替代。

### 迁移快照自检（`plugin-snapshot.verify`）

本项目的核心用法是绿色目录直接拷到新电脑就能跑，而能否直接跑取决于快照承诺随包携带的东西是否真的躺在 `data\` 里。现在每次刷新快照后当场校验（`plugin-bundle/<名>/package.json` 是否存在、`dsh-config/` 下的配置文件是否非空），结论写进日志并显示在**状态页**；**无随包内容、需联网安装的插件会被单独列出**——离线机器上这些装不回来，必须提前知道。

### 内嵌 npm 修复（2026-09-25）

**症状**：启动时报升级失败 —— `[npm] 'npm' 不是内部或外部命令`，随后 `自动升级失败，可手动执行: npm i -g @deepseek-ai/dsh@latest`。

**根因**：产物**从来没有内嵌 npm**。本机没有独立 Node.js（`node` 就是 Electron，而 Electron 发行包**不含 npm**），所以构建脚本原有的候选源（`node_modules\npm`、`node 旁的 node_modules\npm`）必然全部落空；`build-uat.mjs` 当时还是**静默跳过**，因此问题长期不可见。而 dsh 的首次安装与自动升级都依赖内嵌 npm（`launcher.findEmbeddedNpmCli` → `resources\node_modules\npm\bin\npm-cli.js`），缺失时回退到 PATH 的 `npm` 并必然失败。

**修复**：
- 新增 `scripts/fetch-npm.mjs`：从 registry 取 npm 发布的 tarball（**自带 node_modules，解压即自包含**）解压到 `out\_npm\package`，与 `out\_pnpm11` 同一模式。⚠️ **这是构建前置步骤**——缺了它会重新退化成"无内嵌 npm"。
- 三个构建脚本（`build-uat.mjs` / `build-portable.mjs` / `prepare-extra.mjs`）的候选源统一补上 `out\_npm\package`，并改为按 `bin/npm-cli.js` 的存在性判定（目录存在不代表它就是 npm）。
- `build-uat.mjs` 的静默跳过改为**明确告警 + 补救命令**。
- 复制时剔除 npm 的 `docs` / `test` / `tap-snapshots`（运行链路不需要）。

**验证**：内嵌 npm 12.1.0 在 Electron RunAsNode 下 `--version` 正常；真实执行 `npm install -g @deepseek-ai/dsh@0.1.5-rc.3 --prefix …` **成功**（518 包 / 2 分钟），装出的 dsh 可正常启动，且壳依赖的三条契约（就绪行 / 303+cookie 换发 / 首页 `__DSH_BOOT__`）在新版本上逐一复验通过。

### 内嵌 node.exe 自愈（2026-09-25）

**症状**：一次绿色目录构建之后，PATH 上的 `node` 突然消失，随后任何依赖它的命令都失败。

**根因**：`out\<绿目录>\node.exe` 是 **launcher 在运行期创建的硬链接**（`prepareEmbeddedInstallEnv` 把 `DSH-App.exe` 硬链为 `node.exe`，让 dsh 原生依赖的 postinstall 能解析到 `node` —— 本机没有系统 Node.js；发布链因此刻意排除它）。而它此前**只在安装/升级 dsh 时**才会被创建，于是 `build-portable.mjs` / `build-uat.mjs` 的 `rmSync(appDir)`（只备份 `data\`）之后它不会自动恢复。若此时 dsh 已经装好，下次启动不再走安装路径，`node.exe` 就一直缺失。

**修复**：`bootstrap()` 在 `launcher.detect()` 之后**每次启动幂等确保**它存在 —— 已存在时只做一次 `existsSync`（零开销），缺失时硬链接（同盘零拷贝）、失败才回退复制，并记录"内嵌运行时入口就绪"或明确告警。

### Electron 与 dsh 版本升级（2026-09-26）

**当前组合**：Electron **45.0.0-alpha.6** ＋ dsh **0.1.7-rc.2**（升级前为 Electron 44.3.0 + dsh 0.1.5-rc.3）。

**为什么必须用这个 alpha 版 Electron**：dsh 0.1.7 起，`dsh-app-boot` 新增了 hook Node 内部 ESM/CJS loader 的「运行时拦截」（该包体积从 69,644 涨到 181,776 字符），其原生模块 `node-addon-require-builtin` 会对 Electron 运行时做**精确版本指纹校验**：

```
supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6
```

实测确认这是**精确匹配、不是范围**——同为 44.x 也被拒：

| Electron | 运行时指纹 | 结果 |
|---|---|---|
| 44.3.0（原） | node 24.20.0 / v8 `15.2.124.19` | ✗ `Unsupported/no-context` |
| **44.4.5（当前最新稳定）** | node 24.21.0 / v8 `15.2.124.28` | ✗ 同样被拒 |
| **45.0.0-alpha.6** | node 24.21.0 / v8 `15.4.80` | ✅ 通过 |

因此在「不降级」的前提下，**唯一可用**的就是 45.0.0-alpha.6。若将来上游放宽白名单，可换回稳定版。

**Electron 二进制怎么拿到**：本机网络下不动——实测 GitHub 走代理仅 **0.05 MB/s**（包 150.9 MB，需 50 分钟以上），四个国内镜像全部超时或 404。可行做法是**手工下载 zip 后放进来**：

```powershell
# 1) 下载（约 150 MB）
#    https://github.com/electron/electron/releases/download/v45.0.0-alpha.6/electron-v45.0.0-alpha.6-win32-x64.zip
# 2) 先备份旧运行时，再解压覆盖：
#    node_modules\electron\dist  →  electron-v45.0.0-alpha.6 解压内容（electron.exe 需改名为 DSH-App.exe 的那一步由构建脚本做）
# 3) 同步 package.json 的 devDependencies.electron 与 node_modules\electron\package.json 的 version
```

**dsh 怎么升**：0.1.7-rc.2 在 npm 的 **`next`** tag 下（`latest` 仍是 0.1.5-rc.3），所以「启动时检查更新」**不会**跟到它——需要显式装：

```powershell
& "<绿目录>\DSH-App.exe" "<绿目录>\resources\node_modules\npm\bin\npm-cli.js" `
  install -g @deepseek-ai/dsh@0.1.7-rc.2 --prefix "<绿目录>\data\node-global" `
  --registry https://registry.npmmirror.com --no-fund --no-audit --force
```

（升级后 `updater` 仍只比对 `latest`=0.1.5-rc.3，比当前版本低，因此**不会**把它降回去。）

**补丁随版本变化**：0.1.7 把 R19 想修的两处**自己修好了**（`dsh-subprocess-local` 重写为 runner 机制且自带 `windowsHide: true`；`dsh-win32-process` 直接用 `dwFlags: 257, wShowWindow: 0`），所以 R19 现在只在**锚点存在时**才打补丁，否则记录"上游已自带"而不是误报"版本变化"。R28 则多了一个上游字段（`inputModalities`），已做**多版本锚点适配**——锚点与替换体必须成对，否则会把该字段从补丁后的代码里吃掉（模型静默丢掉图片能力）。

**验证结论**（隔离 `DSH_HOME` + 独立 `--user-data-dir` + 临时端口实测）：dsh 就绪 **3.0 秒**、令牌换发 303+cookie、首页 200 且 `__DSH_BOOT__` 就位、0 个绝对 URL、五个补丁全部按预期工作。

### 发布链安全修复（G1）

`publish.mjs` 早已排除脱敏前的 `*.bak-scrub` 备份（含真实邮箱/密钥原始值），而 `release.ps1` **没有**这条规则，偏偏 `-Scrub` 会生成这类备份 → 原始凭据可经该链路上传。两处规则现已统一放宽为「排除一切 `*.bak` 变体」（含 `.bak-nobom-*`、`.bak-version`、`.bak-machineadapt-*`），并由 `tests/v190.test.js` 锁死对称性。

---

## 日志（`data\logs\`）

| 文件 | 内容 | 时间戳 |
|---|---|---|
| `app.log` | 壳自身诊断（启动/看门狗/网关管理），超 1MB `rename` 轮转为 `.prev`（保留历史、不复制不丢段） | `[YYYY-MM-DD HH:mm:ss] ` |
| `web.log` | `dsh web` 子进程的 stdout + stderr 直通，**看门狗据此定位故障插件** | `[YYYY-MM-DD HH:mm:ss] `（2026-09-22 起） |
| `gateway.log`（网关目录） | 模型网关的路由/熔断/上游错误 | `[YYYY-MM-DD HH:mm:ss.mmm] ` |
| `crash-<时间>-<来源>.log`（v1.9.0） | **致命错误现场**（main / renderer / web / gateway），保留最近 10 份，落盘前做基础凭据脱敏；见「v1.9.0」节 | `时间        : YYYY-MM-DD HH:mm:ss (时区)` |

时间口径统一走 `timestamp.js`：**缺省北京时间（UTC+8），与机器时区无关**（镜像/克隆的 Windows 常把时区留在 UTC，旧实现用 `toISOString()` 会让日志早 8 小时，排查时序严重误导）；需要别的口径用 `DSH_LOG_TZ`：`local` 跟随系统，或 `+09:00` / `-05:30` 指定偏移。每次启动的第一行会写明当前口径，事后核对不必猜。

**web.log 的行语义**（2026-09-22 排查新电脑启动故障时加）：stdout 的 chunk 不保证按行切分，因此实现为「**整行立即落盘 + 半行暂存**」——只有见到 `\n` 才算一行结束并补时间戳；暂存段若 250ms 内没有后续数据（说明那本就是一整行、只是没带换行）则自动补时间戳落盘；每次启动前把上次残留的半行先落盘，避免两次启动的输出粘在一行。堆栈的缩进行各自独立带时间戳，不再糊成一团。加时间戳后**看门狗解析不受影响**：解析前先剥掉前缀（`stripLogStamp`），`tests/runtime.test.js` 有专门用例守住"时间戳不得污染条目名"。

## 安全模式（插件故障兜底）
dsh 的插件加载器对「任一插件 apply 失败」fail-loud（整体启动失败），坏插件会让 `dsh web` 起不来——而管理插件的 UI 又恰在服务内（死锁）。壳的看门狗在启动失败时自动处理：

1. 解析 `logs/web.log` 中的失败插件名（兼容 0.1.x 的三种报错形态）；
2. **Level 1**：`dsh --profile web --dump-config` 匹配条目 id → 生成 `safe.yml`（`disabled: true`）→ 带 `--patch` 重启；
3. **Level 2 兜底**：无法定位条目时，备份 `~/.dsh/profiles/web` 的 `package.json`/`cordis.patch.yml` → 写最小配置（仅官方 bundles）→ 重启；
4. 安全模式仍失败 → 停手并在界面提示（避免无限循环）；
5. 「退出安全模式并重启」（设置页/横幅）→ 删补丁 + 还原备份 + 正常重启。

**隔离对象的选择（2026-09-22 新电脑事故后收紧）**：`N entries did not activate` 报错块里每一行的语义并不同——`pending (waiting for service: X)` 是**依赖受害者**（它没起来是因为 X 没被提供），只有带 `Error:` 的行才是**真故障**。旧版一视同仁，于是把 `typert` / `settings` / `credentials` / `llm-pi-ai` / `connection` / `sandbox-policy` 这些**服务提供者**也写进了 `safe.yml`：依赖它们的条目随即永远等不到服务（实测 13 条 pending），**安全模式自身必然启动失败**，用户被锁死在无法自愈的状态（只能手删 `safe.yml`）。现在：

- 只把**真故障**（`Error:` 行、`plugin(s) failed to load`、`failed to apply loader entry`）作为隔离候选，`pending` 行只用于说明"谁是受害者"；
- **核心服务条目永不隔离**（`@deepseek-ai/dsh-*` 且不在 profile 的 dependencies 里 → 视为核心，禁用即瘫痪）；
- 真故障条目 **> 6 个**视为系统性故障（整棵树没起来，而非某个坏插件）→ 不做 Level 1 隔离，直接交还用户（界面提示"不宜自动隔离"+ 日志指引），避免造出一个必然失败的启动配置；
- 判定逻辑独立成 `classifyDidNotActivate()` / `isolationCandidates()`，`tests/unit.js`（4 个用例）与 `tests/runtime.test.js`（1 个端到端用例，用事故原始日志）逐条守住。

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

# 2) 发布到 GitHub（node 实现 `scripts/publish.mjs`；API Token 仅在内存中）
node scripts/publish.mjs --token <TOKEN>            # 或设环境变量 DSH_GH_TOKEN
#   自动完成：安全闸门（真实邮箱/密钥检测，命中即中止）→ 打绿色版 zip（剔除 data\、logs\、
#   node.exe、*.log/*.tmp，打包后再校验 zip 结构）→ 上传源码（剔除 node_modules/out/dist/.git）
#   → 创建/复用 v<version> release（正文取 package.json 的 dshApp.releaseNotes）→ 上传 3 个资产
#   （同名旧资产先改名保留，新资产成功后才删）→ 断言资产名与大小和本地一致。
#   可选：--skip-source / --skip-assets / --zip-from <绿色目录> / --notes-file <本版说明.md>
#   （旧版 PowerShell 流程 scripts\release.ps1 / reupload-zip.ps1 仍保留，语义一致）

# 3) 大文件上传断线补传（可选）
powershell -ExecutionPolicy Bypass -File scripts\reupload-zip.ps1 -Token <TOKEN>
```

> 提示：PS5.1 下脚本须为 UTF-8 **带 BOM**（否则中文注释乱码）；脚本内读 `package.json` 显式指定 `-Encoding UTF8`。

## 测试

```powershell
npm test          # 7 个套件、共 290 个用例，全部在临时目录内操作，不触碰真实用户数据
npm run check     # 语法检查
```

| 套件 | 覆盖 |
|---|---|
| `tests/unit.js` | 纯逻辑单测（版本比较 / 看门狗日志解析 / 网关配置校验） |
| `tests/integration.js` | 无需 Electron 的托管逻辑（网关配置读写与解包 / 安全模式文件往返 / 默认插件安装与自检） |
| `tests/market.test.js` | 插件市场条目标准化与源配置 |
| `tests/email-scrub.test.mjs` | **发布安全闸门**（真实邮箱/密钥拦截、占位符不误报、fail-closed） |
| `tests/runtime.test.js` | 运行时回归：launcher 状态机 / 看门狗终态 / 市场包名校验 / 网关管理器 / 主进程接线 / 渲染层结构 / **换机首启适配**（失效 authFile 清空且不动 Key、按 domain 判区域启停、无凭据停用、代理不可达关闭、幂等与备份、坏配置不阻断、启动接线顺序） |
| `tests/gateway.test.js` | **模型网关端到端**（进程内假上游 + 真启动网关进程）：鉴权 / SSE 透传与聚合 / **协议翻译**（Anthropic↔OpenAI、工具名迟到、thinking 回传与"学习"、**不支持 thinking 的剥离重试**）/ **WorkBuddy** 桌面身份、使用端三头与凭据刷新 / **WorkBuddy 区域守卫**（国内凭据不得发往国际端点，且不得真的发出请求）/ **账户池与多 Key 轮换**（裸 401/403 换 Key 不熔断整家、全部 Key 失败才换家）/ **熔断分级**（401/403/402 长熔断、网络类指数退避、半开短超时、**声明 timeoutMs 时探测不再被压到 10s**）/ **账户池冷却粒度**（限流按「供应商+账户+模型」冷却、不连坐其它模型；额度耗尽仍是账户级）/ **选路顺序**（priority 优先、同级按数组、层级优先于优先级）/ **图片请求选择 vision 变体** / 内容拦截与降敏重试 / SSE 首事件即错误 / 客户端断开 / 413 / 畸形 Host / write-dsh 的 YAML 定位 / **代理事故回归** / **2026-09-23 审计修复回归**（D5 思维链字段名兼容、**Cline 客户端仿真**（主机名推断纯函数 + 显式 clientProfile 端到端发头）、D2「200 + 错误 SSE」确实开闸、D1 半开名额不泄漏、D6 账户失败原因脱敏、D7 Responses 路径 quirks、D11 超大错误体读满即停） |
| `tests/v190.test.js` | **v1.9.0 新增能力（31 项）**：崩溃报告（5 类凭据脱敏 / 保留 10 份 / 同毫秒撞名不覆盖 / 未初始化安全降级）、退出前任务确认（会话写入与网关流量双信号 / 窗口边界闭区间 / DSH_HOME 缺失降级）、cookie 引导（**真实 HTTP 端到端**：303+Set-Cookie → 写入 jar 且属性正确 / 非 303 不写 / Set-Cookie 属性解析含 SameSite 取值域转换 / 去令牌与非法 URL 回退）、迁移快照自检（包体缺失 / 配置缺失 / 需联网安装三类判定），外加**接线冒烟**（统一加载入口 / cookie 状态复位 / 退出确认 / 崩溃报告三类现场 / 迁移自检 / **三个构建脚本的 npm 候选** / **cookie 必用全局 fetch**）与 **G1 发布链规则对称性** |

> 本机若未安装独立 Node.js，`node` 会解析到随应用分发的 `DSH-App.exe`（Electron 的
> `ELECTRON_RUN_AS_NODE` 模式）——测试已适配（`process.noAsar`、`process.resourcesPath`
> 只读、子进程管道 stdio 受限等）。

## 已知边界

- 未做 macOS 深度适配（架构预留，`tray`/`updater` 均为跨平台 API，需真机验证）；
- 「终端」未内置（官方项目的 node-pty 需要原生编译，与"免 VS 工具链"约束冲突）；需要终端时请用系统终端；
- 与 dsh 的交互面严格限定在稳定契约内，不读取 dsh 内部文件（`lib/*.js` 等）。

## License

MIT