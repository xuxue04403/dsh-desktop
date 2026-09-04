# DSH Desktop（DSH 桌面助手）

**Windows 托盘工具：一键启动 / 停止 / 自动更新 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh web` 服务。**

不再需要手动开 PowerShell、记命令、敲 URL —— 双击图标即可。

## 📦 v1.3.5 更新亮点

- 🤖 **Anthropic 协议支持（Claude Code 直接可用）**：网关新增 `/v1/messages` 端点——支持 `x-api-key` 鉴权 + `anthropic-version` 头、Anthropic 格式请求/响应、SSE 事件流（message_start/content_block_delta/message_stop）完整透传、模型名 `[标记]` 后缀自动清洗（如 `glm-5.3[1m]` → `glm-5.3`）、Anthropic 风格错误码
- 🛡️ **分级熔断防封（升级）**：401/403 业务性拒绝（如"需充值"）**首次出现立即熔断 30 分钟**；网络错误/5xx 连续 3 次熔断 5 分钟——熔断期路由完全跳过该供应商（零上游请求），半开试探自动恢复；上游错误日志自动脱敏（key 打码）
- 🎨 **界面重构优化**：窗口固定 880×640（禁止拉伸留白）；表格列宽重调（供应商 ID/Key 完整显示、模型列防折行、固定行高）；「📋 一键复制 Key」按钮 + 剪贴板占用重试；网关日志清屏修复（只显示新日志）；按钮文字不再截断
- 📜 **日志体系**：网关日志与 dsh 日志分离展示 + 调用日志（模型→路由→状态→耗时→来源，含 `proto=anthropic` 标记）+ 双页语义着色（错误红/成功绿/调用青/警告黄）+ 自动换行
- 🔀 **路由模式双选**：主备(优先级) / 轮询(流量分摊)，均保留失败切换
- 🛡️ **防封客户端仿真**：`clientUA` 配置完全仿真 Claude Code 访问特征，通过 new-api/one-api 白名单检测，仿真模式不透传任何 dsh/网关特征头
- 🔌 **baseURL 智能补全**：自动补 `/v1`、收敛误填完整路径
- 🧯 **请求风暴防护**：catalog 失败 30s 冷却 + 并发去重
- 🧩 之前版本：Tab 双页界面、供应商可视化编辑、安装版 `DSHDesktopSetup.exe`、模型网关（统一 base_url/key、可用性探测、优先级路由、故障切换、SSE 透传）

---

## ✨ 特性

| | |
|---|---|
| 🖱️ **一键启动 = 重启** | 自动检测并停止已有 dsh 进程（含手动命令行启动的），等端口释放后全新拉起，确保每次都是最新版 |
| 📦 **双安装来源自适应** | 同时识别「npm 全局安装」（含 nvm-windows 布局）和「npx 缓存」，自动选版本更高者；首次未安装时弹窗引导选择并自动安装 |
| ⬆️ **自动检查更新** | 启动前联网对比 npm 源版本，有新版按来源自动升级（`npm i -g @latest` / `npx --prefer-online`），断网不阻塞 |
| 🌐 **就绪自动开浏览器** | 轮询健康状态，服务就绪自动打开默认浏览器 + 托盘气泡提示 |
| 📋 **系统托盘常驻** | 关窗只是缩到托盘；甚至退出程序，dsh 服务也能独立后台运行 |
| 📄 **日志全落盘** | dsh 输出与助手诊断信息实时写入日志文件（上一份自动备份 `.prev`）；崩溃时自动转储 `crash-*.log` 完整堆栈 |
| 🛡️ **安全细节** | 结束进程前校验目标身份（仅 node/cmd/npm 家族），防止误杀占用端口的无关程序 |
| 🚪 **模型网关（new-api 风格）** | 内置多供应商统一代理：配置多个上游（同一模型多个供应商）后，对外提供**统一 base_url + 统一 key**，自动探测可用性并按优先级路由、故障切换，支持 SSE 流式；一键写入 dsh 配置成为「gateway」提供商 |
| 📂 **绿色便携** | 助手自身数据（设置/日志/网关配置）默认放在程序目录旁 `data\`（不可写时回退 `%APPDATA%`，旧数据自动迁移），可通过环境变量 `DSH_DATA_DIR` 指定位置 |
| 🔁 **开机自启** | 可选，登录时自动运行助手并拉起 dsh |

## 🚀 快速开始

**环境要求**：Windows 10/11（系统自带 .NET Framework 4.x，无需装任何运行时）+ 已安装 Node.js/npm

**获取程序**：

- **安装版（推荐）**：到 [Releases](../../releases) 下载 `DSHDesktopSetup.exe`（单文件安装器）→ 双击安装 → 自动创建桌面/开始菜单快捷方式与卸载入口（卸载时保留 `data\` 用户数据）
- **便携版**：下载 `DSHDesktop-portable.zip`，解压到任意目录双击 `DSHDesktop.exe` 即用（数据随程序目录）
- **自己编译**（一行命令，用 Windows 自带的 C# 编译器，无需 SDK）：

  ```powershell
  powershell -ExecutionPolicy Bypass -File build.ps1   # 同时产出 DSHDesktop.exe 与 DSHDesktopSetup.exe
  ```

**使用**：双击 `DSHDesktop.exe` → 点「一键启动」。首次未安装 dsh 时会引导你选择 npm 全局 / npx 缓存方式。

## 🧰 工作原理

```
一键启动
 ├─ 检测已有 dsh 进程（netstat 定位端口 + 身份校验）→ 有则先停止并等待端口释放
 ├─ 联网检查 dsh 版本 → 按安装来源路由更新（全局→npm i -g；缓存→npx --prefer-online）
 ├─ 选择启动目标：npm 缓存直连（快）/ 全局 dsh.cmd / 首次回退 npx 自动安装
 └─ cmd 规范引号形态拉起进程，输出重定向到日志文件；健康轮询就绪后自动开浏览器
```

设置与日志位置：默认 `exe 旁 data\`（`settings.ini`、`logs\dsh-web.log[.prev]`、`logs\crash-*.log`、`gateway.config.json`）；不可写时回退 `%APPDATA%\DSHDesktop\`；可用环境变量 `DSH_DATA_DIR` 指定位置。

## 🚪 模型网关（new-api 风格）

把多个供应商（OpenAI 兼容端点）聚合成**一个统一接口**：

```
统一接口  http://127.0.0.1:3090/v1    Bearer <统一Key>
  ├─ /v1/models             → 各上游模型合并去重
  └─ /v1/chat/completions   → 可用性探测 → 按优先级路由 → 故障自动切换（含 SSE 流式）
```

**用法**：
1. 主界面「模型网关」面板 → **编辑供应商**：编辑 `gateway.config.json`，填多个 `providers`（baseURL / apiKey / models / priority），保存
   ```json
   {
     "port": 3090,
     "apiKey": "你的统一Key",
     "providers": [
       { "id": "supplier-a", "baseURL": "https://a.com/v1", "apiKey": "sk-...",
         "models": ["deepseek-v4-flash"], "priority": 1, "enabled": true },
       { "id": "supplier-b", "baseURL": "https://b.com/v1", "apiKey": "sk-...",
         "models": ["deepseek-v4-flash"], "priority": 2, "enabled": true }
     ]
   }
   ```
2. **启动网关**（状态灯变绿）
3. **写入 dsh 配置**：自动把网关注册为 `settings.yaml` 的 `llm-pi-ai.providers.gateway` 并把统一 Key 写入 `~/.dsh/.credentials.yaml`（`DSH_GATEWAY_API_KEY`）
4. 重启 dsh web → 模型选择器里选 `gateway / deepseek-v4-flash` 即可；任何 OpenAI 兼容客户端也可直接用统一接口

## 🛠️ 构建

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1   # 本地编译
```

仓库内置 GitHub Actions 工作流（`.github/workflows/build.yml`）：push 即在 windows-latest 上编译并上传 artifact。

## 📁 目录结构

```
├── DSHDesktop.cs          # 全部源码（单文件 WinForms）
├── build.ps1              # 编译脚本（调用系统自带 csc）
├── build_icon.ps1         # 应用图标生成脚本
├── install_shortcut.ps1   # 创建桌面快捷方式
├── app.ico                # 应用图标
├── gateway/               # 模型网关（Node.js 零依赖）
│   ├── model-gateway.mjs        # 网关主体
│   ├── gateway.config.example.json
│   ├── _mock-upstreams.mjs      # 本地测试桩上游
│   └── _e2e-test.ps1/.mjs       # 端到端测试
└── .github/workflows/     # CI
```

## 🤝 相关链接

- 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 反馈本工具问题：请提 Issue；dsh 本体的问题请去上游仓库 Discussions

## License

[MIT](LICENSE)
