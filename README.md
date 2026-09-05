# DSH App

自研的 DeepSeek Harness 桌面壳（Electron），**参考 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 的薄宿主架构自行实现**，与官方项目无代码关系：

- **薄 Electron 宿主**：窗口 / 托盘 / 设置 / 看门狗，全部由壳负责；
- **进程外启动 `dsh web`**：通过稳定契约（`--no-open --port`、stdout `dsh web:<url>` 就绪行、`--patch` 覆盖层）驱动官方 dsh CLI，壳与 dsh 完全解耦——升级 dsh 不影响壳；
- **看门狗 + 安全模式**：插件故障导致 dsh 启动失败时，自动解析日志 → `--dump-config` 匹配条目 → 生成 `--patch safe.yml` 禁用故障插件重启（Level 1）；无法定位时临时剥离第三方插件（Level 2，原配置自动备份），一键恢复；
- **模型网关（可视化配置）**：设置页内置网关卡——供应商表格（启用开关 / ID / baseURL / 模型数 / 优先级），行末「编辑 / 删除」，下方编辑面板仿 dsh 模型配置页布局；JSON 高级区与表格双向同步；优先级路由 + 故障切换 + SSE + 分级熔断 + 一键「写入 dsh 配置」；
- **对话输入历史**：在 Harness 对话框内按 **↑ / ↓** 查看本会话历史输入（按会话独立存储，Enter 发送后自动入列；不干扰 dsh 的 Enter/换行逻辑）；
- **壳级入口常驻**：dsh 页面右上角悬浮「⚙ 设置 / 🛡 模型网关」按钮（服务就绪后仍可直达并定位高亮）；托盘菜单同款入口；
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
│   ├── main.js         # 主进程：装配 + IPC + 生命周期 + 单实例锁
│   ├── preload.js      # 渲染进程安全桥（contextIsolation）
│   ├── launcher.js     # dsh 发现/启动/停止/健康/就绪行解析（稳定契约）
│   ├── watchdog.js     # 看门狗 + 安全模式（Level 1 / Level 2 / 一键恢复）
│   ├── settings.js     # 设置持久化（userData/settings.json）
│   ├── logger.js       # 日志落盘（app.log + web.log）
│   ├── state.js        # 壳级状态机 + 广播
│   ├── tray.js         # 系统托盘
│   ├── updater.js      # dsh 版本检查（直连 npm registry，免外部程序）
│   ├── gateway-manager.js # 模型网关托管（复用桌面助手网关运行时）
│   └── gateway/        # 模型网关运行时（model-gateway.mjs，零依赖，原样分发）
├── renderer/
│   ├── status.html     # 引导/失败/安全模式页
│   └── settings.html   # 设置页（含模型网关面板）
├── scripts/
│   ├── build-portable.mjs   # 绿色免安装版（手工 asar + dist 复制）
│   └── portable.mirror.mjs  # 单文件便携 exe（electron-builder + 镜像）
└── tests/unit.js       # 纯逻辑单测（node tests/unit.js）
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
- **「写入 dsh 配置」**：自动把网关注册为 dsh 的 `gateway` 提供商并写入统一 Key，重启 dsh web 后在模型选择器直接选用；
- 配置（供应商列表/优先级/Key）保存在 `%APPDATA%\DSH-App\gateway.config.json`（与桌面助手 `data\gateway.config.json` 同构，可直接迁移）。

## 打包分发（免安装版）

```powershell
cd dsh-app
npm install
node scripts/build-portable.mjs        # 绿色免安装版 → out/DSH-App/（双击 DSH-App.exe 即用）
node scripts/portable.mirror.mjs       # 单文件便携 exe（electron-builder + npmmirror 镜像）
npm run dist                           # 完整安装包（NSIS）
```

- 绿色版无需安装、不写注册表；运行数据在 `%APPDATA%\DSH-App\`，删除即重置；
- 两种打包均**不需要 Visual Studio C++ 工具链**；
- 若 GitHub 下载慢，打包工具已走 npmmirror 镜像（`portable.mirror.mjs` 内置），也可用环境变量 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 覆盖。

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

## 打包分发

```powershell
npm run dist    # electron-builder 产出 NSIS 安装包（out/）
npm run pack    # 仅产出解包目录（快速自测）
```

图标由 `src/icon.js` 程序化生成（品牌蓝徽标，零外部资源），保证 **托盘 / 窗口 / exe 图案统一**：

- **托盘图标**：与 exe 同一徽标图案，随服务状态**变色**——灰=已停止 / 黄=启动中 / 绿=运行中 / 红=失败 / 橙=安全模式；首次启动会弹出气泡提示（若图标被 Windows 收进溢出区，点任务栏「^」即可找到）；
- **窗口/任务栏图标**：启动时生成（`BrowserWindow.icon`），与托盘同图案；
- **exe 图标**：打包脚本会生成标准 `icon.ico`（16/32/256 多尺寸，绿色目录根与 `assets/`）。绿色版的 exe 资源图标请在本机执行一次：
  ```powershell
  npm i -D rcedit
  node scripts/set-exe-icon.cjs      # 替换 out\DSH-App\DSH-App.exe 图标（重启后生效）
  ```
  之后资源管理器/任务栏中的 exe 图标即与托盘/窗口图案一致；electron-builder 单文件打包（`npm run portable:mirror`）会直接用 `assets/icon.ico` 自动嵌入，无需手动步骤。

> 若托盘图标仍看不到：右击任务栏空白处 →「任务栏设置」→「选择要在任务栏上显示的图标」→ 打开 DSH App 开关（Windows 11）/ 或在「通知区域」设置中把 DSH App 设为"始终显示"（Windows 10）。

## 发布（V1.5.0）

```powershell
# 1) 编译产物（本机执行）
npm i -D rcedit
npm run dist:mirror          # NSIS 安装版 + 单文件便携（dist/，走 npmmirror 镜像，免 VS 工具链）
node scripts/build-portable.mjs   # 绿色版（out/DSH-App/；若旧目录被运行中实例占用：
                                #   $env:OUT_NAME='DSH-App-v1.5.0' 后重跑）

# 2) 发布到 GitHub（无需 git 客户端，API Token 仅在内存中）
powershell -ExecutionPolicy Bypass -File scripts\release-v1.5.0.ps1 -Token <TOKEN> [-CleanOld]
#   -CleanOld：清理仓库里 v1.x C# 桌面助手的旧文件（setup/、gateway/、DSHDesktop.cs 等）
#   Release v1.5.0 附带：安装版 exe / 单文件便携 exe / 绿色版 zip
```

## 测试

```powershell
npm test          # 单测 16 项 + 集成 9 项（看门狗/网关/图标/安全模式文件往返）
npm run check     # 语法检查
```

## 已知边界

- 未做 macOS 深度适配（架构预留，`tray`/`updater` 均为跨平台 API，需真机验证）；
- 「终端」未内置（官方项目的 node-pty 需要原生编译，与"免 VS 工具链"约束冲突）；需要终端时请用系统终端；
- 与 dsh 的交互面严格限定在稳定契约内，不读取 dsh 内部文件（`lib/*.js` 等）。

## License

MIT