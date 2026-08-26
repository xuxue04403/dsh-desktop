# DSH Desktop（DSH 桌面助手）

**Windows 托盘工具：一键启动 / 停止 / 自动更新 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh web` 服务。**

不再需要手动开 PowerShell、记命令、敲 URL —— 双击图标即可。

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
| 🔁 **开机自启** | 可选，登录时自动运行助手并拉起 dsh |

## 🚀 快速开始

**环境要求**：Windows 10/11（系统自带 .NET Framework 4.x，无需装任何运行时）+ 已安装 Node.js/npm

**获取程序**（二选一）：

- 下载编译好的：到 [Releases](../../releases) 页下载 `DSHDesktop.exe`
- 自己编译（一行命令，用 Windows 自带的 C# 编译器，无需 SDK）：

  ```powershell
  powershell -ExecutionPolicy Bypass -File build.ps1
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

设置与日志位置：`%APPDATA%\DSHDesktop\`（`settings.ini`、`logs\dsh-web.log[.prev]`、`logs\crash-*.log`）

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
└── .github/workflows/     # CI
```

## 🤝 相关链接

- 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 反馈本工具问题：请提 Issue；dsh 本体的问题请去上游仓库 Discussions

## License

[MIT](LICENSE)
