using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace DSHDesktop
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool autoStartFlag = false;
            if (args != null)
            {
                foreach (string a in args)
                {
                    string t = (a ?? "").Trim().ToLowerInvariant();
                    if (t == "-autostart") autoStartFlag = true;
                }
            }

            bool createdNew;
            using (Mutex m = new Mutex(true, @"Local\DSHDesktop_Singleton", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("DSH 桌面助手已在运行（请查看系统托盘图标）。", "DSH 桌面助手",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // 全局异常兜底：
                // ① UI 消息循环内的异常 → 记录崩溃日志并继续运行（不再弹系统错误框、不再无声中断功能）
                // ② 后台线程（Timer / Process.Exited / ThreadPool）的未捕获异常 → 先落盘证据再随进程终止。
                //    否则进程会无声消失且零痕迹——"运行一段时间后自动退出"的首要嫌疑就是它。
                Application.ThreadException += new System.Threading.ThreadExceptionEventHandler(delegate(object s, System.Threading.ThreadExceptionEventArgs e)
                {
                    WriteCrashLog("UI线程异常（已捕获，程序继续运行）", e.Exception);
                });
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                AppDomain.CurrentDomain.UnhandledException += new UnhandledExceptionEventHandler(delegate(object s, UnhandledExceptionEventArgs e)
                {
                    WriteCrashLog("未处理异常（非UI线程，进程即将终止）", e.ExceptionObject as Exception);
                });

                using (MainForm f = new MainForm(autoStartFlag))
                {
                    Application.Run(f);
                }
            }
        }

        // 崩溃转储：%APPDATA%\DSHDesktop\logs\crash-时间.log
        private static void WriteCrashLog(string kind, Exception ex)
        {
            try
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "DSHDesktop", "logs");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                string file = Path.Combine(dir, "crash-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("=== " + kind + " @ " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ===");
                sb.AppendLine(ex == null ? "<非异常对象>" : ex.ToString());
                File.WriteAllText(file, sb.ToString(), Encoding.UTF8);
            }
            catch { }
        }
    }

    class MainForm : Form
    {
        // ---------- 设置 ----------
        private string settingsDir;
        private string settingsFile;
        private string logDir;
        private string logPath;
        private int port = 3080;
        private string workDir = "";                 // 空 = 使用用户主目录（可在设置中修改）
        private bool autoOpenBrowser = true;
        private bool autoStartService = false;
        private bool autoUpdate = true;
        private string installMode = "auto";         // 安装方式偏好：auto（版本高者）| global | cache

        // ---------- 运行状态 ----------
        private Process dshProc;
        private volatile bool starting = false;
        private volatile bool manuallyStopped = false;
        private int autoOpenedFlag = 0;              // 就绪自动开浏览器的跨线程一次性闸门
        private DateTime lastAutoOpen = DateTime.MinValue;
        private volatile bool running = false;
        private volatile bool forceNpx = false;      // 检测到新版本时强制走 npx 更新
        private volatile bool cancelStart = false;   // 取消待执行的启动（更新检查期间点停止）
        private string launchSource = "";            // 本次启动来源：cache/global/npx
        private readonly object logLock = new object();
        private DateTime startWaitDeadline;
        private DateTime phaseStart;                 // 本次启动阶段起点（用于 15 分钟绝对超时上限）
        private DateTime lastOutputTime;             // 子进程最后一次产生输出的时间
        private long tailOffset;                     // 日志文件已读取到的偏移
        private int healthBusy = 0;                  // 健康轮询防重入
        private System.Threading.Timer healthTimer;
        private bool forceExit = false;

        // ---------- UI ----------
        private System.Windows.Forms.Timer uiTimer;
        private Button btnStart;
        private Button btnOpen;
        private Button btnStop;
        private ToolStripStatusLabel lblStatus;
        private TextBox txtLog;
        private TextBox txtPort;
        private TextBox txtWorkDir;
        private CheckBox chkAutoOpen;
        private CheckBox chkAutoStart;
        private CheckBox chkUpdate;
        private ComboBox cmbInstall;
        private NotifyIcon tray;
        private ContextMenuStrip trayMenu;
        private ToolStripMenuItem miStart, miOpen, miStop, miShow, miLog, miExit;
        private StatusStrip statusStrip;

        public MainForm(bool autoStartFlag)
        {
            Text = "DSH 桌面助手";
            ClientSize = new Size(580, 440);
            MinimumSize = new Size(520, 380);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9F);

            settingsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DSHDesktop");
            settingsFile = Path.Combine(settingsDir, "settings.ini");
            logDir = Path.Combine(settingsDir, "logs");
            logPath = Path.Combine(logDir, "dsh-web.log");

            // 界面只显示本次会话的日志：跳过磁盘上已有历史，避免打开窗口时刷出上次的日志
            try { if (File.Exists(logPath)) tailOffset = new FileInfo(logPath).Length; } catch { }

            LoadSettings();

            // 默认工作目录：未配置时使用用户主目录（开源通用化，不再硬编码开发机路径）
            if (string.IsNullOrEmpty(workDir))
                workDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

            BuildUi();
            BuildTray();

            uiTimer = new System.Windows.Forms.Timer();
            uiTimer.Interval = 800;
            uiTimer.Tick += OnUiTimerTick;
            uiTimer.Start();

            bool runNow = autoStartFlag || autoStartService;
            if (runNow)
            {
                Shown += delegate { BeginInvoke(new Action(StartService)); };
            }
        }

        private void BuildUi()
        {
            SuspendLayout();

            btnStart = new Button();
            btnStart.Text = "一键启动";
            btnStart.Width = 110; btnStart.Height = 34; btnStart.Left = 16; btnStart.Top = 16;
            btnStart.BackColor = Color.FromArgb(0, 120, 212); btnStart.ForeColor = Color.White;
            btnStart.FlatStyle = FlatStyle.Flat;
            btnStart.Click += OnStartClick;

            btnOpen = new Button();
            btnOpen.Text = "打开浏览器";
            btnOpen.Width = 110; btnOpen.Height = 34; btnOpen.Left = 134; btnOpen.Top = 16;
            btnOpen.FlatStyle = FlatStyle.Flat;
            btnOpen.Click += OnOpenClick;

            btnStop = new Button();
            btnStop.Text = "停止服务";
            btnStop.Width = 110; btnStop.Height = 34; btnStop.Left = 252; btnStop.Top = 16;
            btnStop.FlatStyle = FlatStyle.Flat;
            btnStop.Click += OnStopClick;

            Label lblUrl = new Label();
            lblUrl.Text = "访问地址:";
            lblUrl.SetBounds(400, 22, 70, 22);
            TextBox txtUrl = new TextBox();
            txtUrl.Text = "http://127.0.0.1:" + port + "/";
            txtUrl.ReadOnly = true;
            txtUrl.SetBounds(468, 20, 96, 24);
            txtUrl.BorderStyle = BorderStyle.FixedSingle;

            GroupBox gb = new GroupBox();
            gb.Text = "设置";
            gb.SetBounds(16, 62, 548, 124);
            gb.BackColor = Color.White;

            Label l1 = new Label(); l1.Text = "端口:"; l1.SetBounds(14, 28, 50, 22);
            txtPort = new TextBox(); txtPort.Text = port.ToString(); txtPort.SetBounds(64, 25, 70, 24); txtPort.BorderStyle = BorderStyle.FixedSingle;
            Label l2 = new Label(); l2.Text = "工作目录:"; l2.SetBounds(150, 28, 60, 22);
            txtWorkDir = new TextBox(); txtWorkDir.Text = workDir; txtWorkDir.SetBounds(215, 25, 250, 24); txtWorkDir.BorderStyle = BorderStyle.FixedSingle;
            Button btnBrowse = new Button(); btnBrowse.Text = "..."; btnBrowse.SetBounds(472, 24, 44, 26);
            btnBrowse.Click += delegate { FolderBrowserDialog d = new FolderBrowserDialog(); d.Description = "选择 dsh 工作目录（一般是你的项目文件夹）"; d.SelectedPath = txtWorkDir.Text; if (d.ShowDialog(this) == DialogResult.OK) txtWorkDir.Text = d.SelectedPath; };

            chkAutoOpen = new CheckBox(); chkAutoOpen.Text = "服务就绪后自动打开浏览器"; chkAutoOpen.SetBounds(14, 62, 220, 24); chkAutoOpen.Checked = autoOpenBrowser;
            chkAutoStart = new CheckBox(); chkAutoStart.Text = "开机自动启动（登录时自动运行并启动 dsh）"; chkAutoStart.SetBounds(250, 62, 280, 24); chkAutoStart.Checked = autoStartService;
            chkUpdate = new CheckBox(); chkUpdate.Text = "启动前自动检查 dsh 更新"; chkUpdate.SetBounds(14, 90, 200, 24); chkUpdate.Checked = autoUpdate;

            Label lInst = new Label(); lInst.Text = "安装方式:"; lInst.SetBounds(226, 92, 60, 20);
            cmbInstall = new ComboBox();
            cmbInstall.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbInstall.Items.AddRange(new object[] { "自动择优", "全局安装(npm -g)", "缓存安装(npx)" });
            cmbInstall.SelectedIndex = (installMode == "global") ? 1 : (installMode == "cache") ? 2 : 0;
            cmbInstall.SetBounds(288, 88, 130, 24);
            cmbInstall.SelectedIndexChanged += delegate { ApplyUiSettings(); };

            // 勾选即保存（修复：以前只有点"一键启动"才会写设置和注册表）
            chkAutoOpen.CheckedChanged += delegate { ApplyUiSettings(); };
            chkAutoStart.CheckedChanged += delegate { ApplyUiSettings(); };
            chkUpdate.CheckedChanged += delegate { ApplyUiSettings(); };

            gb.Controls.AddRange(new Control[] { l1, txtPort, l2, txtWorkDir, btnBrowse, chkAutoOpen, chkAutoStart, chkUpdate, lInst, cmbInstall });

            Label l3 = new Label(); l3.Text = "运行日志:"; l3.SetBounds(16, 196, 80, 20);
            txtLog = new TextBox();
            txtLog.Multiline = true;
            txtLog.ReadOnly = true;
            txtLog.ScrollBars = ScrollBars.Vertical;
            txtLog.BackColor = Color.FromArgb(30, 30, 30);
            txtLog.ForeColor = Color.FromArgb(220, 220, 220);
            txtLog.BorderStyle = BorderStyle.FixedSingle;
            txtLog.SetBounds(16, 220, 548, 172);
            txtLog.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;

            statusStrip = new StatusStrip();
            lblStatus = new ToolStripStatusLabel();
            lblStatus.TextAlign = ContentAlignment.MiddleLeft;
            lblStatus.Font = new Font("Microsoft YaHei UI", 9F);
            lblStatus.Spring = true;
            statusStrip.Items.Add(lblStatus);
            statusStrip.Dock = DockStyle.Bottom;
            statusStrip.SizingGrip = false;

            Controls.AddRange(new Control[] { btnStart, btnOpen, btnStop, lblUrl, txtUrl, gb, l3, txtLog, statusStrip });

            ResumeLayout(false);
            PerformLayout();

            UpdateStatusText("[ 就绪 ] 点击「一键启动」或从托盘启动 dsh", Color.DimGray);
        }

        private void BuildTray()
        {
            trayMenu = new ContextMenuStrip();

            miStart = new ToolStripMenuItem("启动 dsh 服务");
            miStart.Click += delegate { BeginInvoke(new Action(StartService)); };
            miShow = new ToolStripMenuItem("显示主窗口");
            miShow.Click += delegate { ShowWindow(); };
            miOpen = new ToolStripMenuItem("打开浏览器");
            miOpen.Click += delegate { OpenBrowser(); };
            miStop = new ToolStripMenuItem("停止 dsh 服务");
            miStop.Click += delegate { StopService(); };
            miLog = new ToolStripMenuItem("打开日志文件夹");
            miLog.Click += delegate { OpenLogsFolder(); };
            miExit = new ToolStripMenuItem("退出");

            trayMenu.Items.AddRange(new ToolStripItem[] { miStart, miShow, miOpen, miStop, miLog, new ToolStripSeparator(), miExit });

            tray = new NotifyIcon();
            tray.Text = "DSH 桌面助手";
            try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { tray.Icon = SystemIcons.Application; }
            tray.ContextMenuStrip = trayMenu;
            tray.Visible = true;
            tray.DoubleClick += delegate { ShowWindow(); };

            // 退出前询问是否停服
            miExit.Click += delegate
            {
                if (IsDshAliveByProcessOrPort())
                {
                    DialogResult r = MessageBox.Show(
                        "检测到 dsh 服务正在运行。退出前要停止它吗？\n\n" +
                        "「是」— 停止服务并退出\n" +
                        "「否」— 保持服务在后台运行，仅退出本程序（安全：日志写入文件，服务不受影响）",
                        "DSH 桌面助手", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                    if (r == DialogResult.Cancel) return;
                    if (r == DialogResult.Yes) StopService();
                }
                forceExit = true;
                Close();
            };
        }

        private void OnUiTimerTick(object sender, EventArgs e)
        {
            TailLog(); // 实时跟踪 dsh 日志文件（无论状态如何都刷新显示）

            if (starting)
            {
                UpdateStatusText("[ 启动中… ] 正在等待 dsh 服务就绪 (http://127.0.0.1:" + port + "/)", Color.OrangeRed);
                if (DateTime.Now > startWaitDeadline)
                {
                    // 续期依据：子进程仍存活（下载/安装中进程不会退出）。
                    // 不能用日志新鲜度判断——助手自己写入的行也会刷新它，会形成自我续期死循环。
                    bool procAlive = (dshProc != null && !dshProc.HasExited);
                    double elapsedMin = (DateTime.Now - phaseStart).TotalMinutes;
                    if (procAlive && elapsedMin < 15)
                    {
                        startWaitDeadline = DateTime.Now.AddSeconds(60);
                        AppendLog("[信息] 安装/下载仍在进行（进程存活），已延长等待时间…");
                    }
                    else
                    {
                        starting = false;
                        StopHealthPolling();
                        if (!procAlive && dshProc != null)
                            UpdateStatusText("[ 启动失败 ] 进程已退出（退出码见日志）", Color.Red);
                        else
                            UpdateStatusText("[ 启动超时 ] 超过 15 分钟仍未就绪，请查看日志", Color.Red);
                        AppendLog("[错误] 服务未能就绪。常见原因：① Node.js 未安装或不在 PATH；② npm 源不可达（网络）；③ 端口被占用；④ 工作目录不存在。详见上方 dsh 实时输出。");
                    }
                }
            }
        }

        private void ShowWindow()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void OnStartClick(object sender, EventArgs e) { StartService(); }
        private void OnOpenClick(object sender, EventArgs e) { OpenBrowser(); }
        private void OnStopClick(object sender, EventArgs e) { StopService(); }

        // 应用界面上的设置并持久化
        private void ApplyUiSettings()
        {
            if (txtPort == null || txtWorkDir == null || chkAutoOpen == null || chkAutoStart == null || chkUpdate == null || cmbInstall == null) return;
            int p;
            if (int.TryParse(txtPort.Text, out p) && p > 0 && p <= 65535) port = p;
            txtPort.Text = port.ToString();

            workDir = txtWorkDir.Text.Trim();
            if (workDir.Length == 0) workDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

            autoOpenBrowser = chkAutoOpen.Checked;
            autoStartService = chkAutoStart.Checked;
            autoUpdate = chkUpdate.Checked;
            int ci = cmbInstall.SelectedIndex;
            installMode = (ci == 1) ? "global" : (ci == 2) ? "cache" : "auto";
            SaveSettings();
        }

        // ---------------- 启动服务 ----------------
        private void StartService()
        {
            if (starting) { AppendLog("[信息] 正在启动中，请稍候…"); return; }

            ApplyUiSettings();

            forceNpx = false;
            cancelStart = false;

            string url = "http://127.0.0.1:" + port + "/";

            // —— 重启语义：一键启动 = 停掉现有 dsh（含手动/旧实例拉起的），再拉起全新实例 ——
            bool wasAlive = IsAlive(url);
            int runningPid = wasAlive ? FindListenerPid(port) : 0;
            bool ownAlive = (dshProc != null && !dshProc.HasExited);

            if (ownAlive || runningPid > 0)
            {
                AppendLog("[重启] 检测到已有 dsh 在运行" +
                    (runningPid > 0 ? "（监听进程 PID " + runningPid + "）" : "") +
                    "，先停止旧进程…");
                // 解绑旧对象退出回调，避免其异步触发干扰新启动流程
                if (dshProc != null) { try { dshProc.Exited -= OnProcExited; } catch { } }

                bool killed = false;
                if (ownAlive) killed = KillTree(dshProc.Id);

                if (!killed && runningPid > 0)
                {
                    // 安全护栏：确认监听进程确实是 node/dsh 家族才动手，防止误杀占用端口的无关程序
                    string pname = GetProcessName(runningPid);
                    if (!IsPlausibleDshName(pname))
                    {
                        UpdateStatusText("[ 重启受阻 ] 端口被其他程序占用", Color.Red);
                        AppendLog("[错误] 端口 " + port + " 的监听进程是 " + (pname ?? "<未知>") +
                            "（PID " + runningPid + "），不是 dsh/node。为避免误杀已中止启动。" +
                            "请更换端口，或手动结束该程序后重试。");
                        return;
                    }
                    AppendLog("[重启] 目标进程名: " + pname);
                    killed = KillTree(runningPid);
                }

                manuallyStopped = true;
                starting = false;
                running = false;
                StopHealthPolling();
                dshProc = null;

                // 等待端口释放（最多 8 秒）
                DateTime freeDeadline = DateTime.Now.AddSeconds(8);
                while (DateTime.Now < freeDeadline && FindListenerPid(port) > 0) Thread.Sleep(250);
                AppendLog(killed
                    ? "[重启] 旧进程已停止，端口已释放。"
                    : "[重启][警告] 未能确认停止结果，继续尝试启动新实例…");
            }
            else if (wasAlive)
            {
                AppendLog("[重启][警告] 端口 " + port + " 有响应但未定位到监听进程，将尝试直接启动（若端口冲突会在日志中体现）。");
            }

            // 安全复查：旧服务确实停干净了才继续，避免端口冲突
            if (IsAlive(url))
            {
                UpdateStatusText("[ 重启受阻 ] 旧服务仍在运行，无法安全启动新实例", Color.Red);
                AppendLog("[错误] 旧的 dsh 服务未能停止（可能需要管理员权限）。为避免端口冲突，本次启动已中止。请手动结束后重试。");
                return;
            }

            // 首次安装引导：本机没有任何 dsh 时，让用户选择安装方式（选择会被记住）
            string iv, isrc, icb, igc;
            GetBestInstall(out iv, out isrc, out icb, out igc);
            launchSource = isrc ?? "";
            if (isrc == null)
            {
                DialogResult dr = MessageBox.Show(this,
                    "本机尚未安装 dsh。请选择安装方式（之后可在设置中更改）：\n\n" +
                    "【是】npm 全局安装 —— 安装到全局目录，稳定、便于手动管理（推荐）\n" +
                    "【否】npx 缓存安装 —— 下载到 npx 缓存并直接启动\n" +
                    "【取消】本次不安装",
                    "首次安装 dsh", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (dr == DialogResult.Cancel)
                {
                    UpdateStatusText("[ 已取消 ] 未选择安装方式", Color.DimGray);
                    AppendLog("[信息] 用户取消了首次安装。");
                    return;
                }
                if (dr == DialogResult.Yes)
                {
                    installMode = "global";
                    cmbInstall.SelectedIndex = 1;
                    SaveSettings();
                    AppendLog("[安装] 已选择：npm 全局安装。开始安装最新版…");
                    StartGlobalUpdateThenStart();
                }
                else
                {
                    installMode = "cache";
                    cmbInstall.SelectedIndex = 2;
                    SaveSettings();
                    AppendLog("[安装] 已选择：npx 缓存安装。将通过 npx 下载并直接启动…");
                    StartProcessCore(); // 走方式3：npx 下载安装并启动
                }
                return;
            }

            if (autoUpdate)
            {
                starting = true;
                // 关键：更新检查阶段就要初始化超时基线，否则会拿上一轮的过期时间误判
                startWaitDeadline = DateTime.Now.AddSeconds(150);
                phaseStart = DateTime.Now;
                UpdateStatusText("[ 更新检查… ] 正在联网检查 dsh 是否可更新", Color.OrangeRed);
                AppendLog("[更新] 正在联网检查 dsh 是否有新版本…");
                ThreadPool.QueueUserWorkItem(delegate(object st) { CheckThenStart(false); });
                return;
            }

            StartProcessCore();
        }

        // 后台线程：联网对比 dsh 版本
        // notifyOnly=true：仅提示有新版（服务正在运行，不打断）；false：发现新版则强制更新后启动
        private void CheckThenStart(bool notifyOnly)
        {
            string installed = null, latest = null, source = null;
            bool newer = false;
            bool checkOk = true;
            string err = null;
            try
            {
                string cb, gc;
                GetBestInstall(out installed, out source, out cb, out gc);
                launchSource = source;
                latest = LatestDshVersion();
                newer = IsNewerVersion(latest, installed);
            }
            catch (Exception ex)
            {
                checkOk = false;
                err = ex.Message;
            }

            OnUiThread(delegate
            {
                if (cancelStart) return; // 用户已点停止，放弃本次启动

                if (!checkOk)
                {
                    AppendLog("[更新] 检查更新失败（" + err + "），按现有版本继续。");
                    if (!notifyOnly) StartProcessCore();
                    return;
                }
                if (newer)
                {
                    if (notifyOnly)
                    {
                        AppendLog("[更新] 发现新版本 " + installed + " → " + latest + "（当前服务未中断；下次「一键启动」将自动更新）。");
                        ShowBalloon("dsh 有新版本 " + latest, "当前 " + installed + "，下次一键启动时自动更新");
                    }
                    else
                    {
                        AppendLog("[更新] 发现新版本 " + installed + " → " + latest + "，正在自动更新并启动…");
                        if (source == "global")
                        {
                            // 全局安装来源：用 npm 更新全局包，成功后继续启动
                            StartGlobalUpdateThenStart();
                        }
                        else
                        {
                            // 缓存来源：用 npx prefer-online 刷新缓存后启动
                            forceNpx = true;
                            StartProcessCore();
                        }
                    }
                }
                else
                {
                    if (!notifyOnly)
                    {
                        if (installed == null)
                        {
                            AppendLog("[更新] 未检测到本机 dsh。" + (installMode == "global" ? "按全局方式（npm -g）安装…" : "将由 npx 自动下载并启动。"));
                            if (installMode == "global")
                                StartGlobalUpdateThenStart();
                            else
                                StartProcessCore();
                        }
                        else
                        {
                            AppendLog("[更新] 已是最新版本（" + (source == "global" ? "全局" : "缓存") + " " + installed + "）。");
                            StartProcessCore();
                        }
                    }
                }
            });
        }

        // 真正拉起 dsh 进程（在 UI 线程执行）
        private void StartProcessCore()
        {
            if (cancelStart)
            {
                starting = false;
                AppendLog("[信息] 启动已被用户取消。");
                UpdateStatusText("[ 已取消 ] 未启动服务", Color.DimGray);
                return;
            }

            string exe, args, desc;
            bool ok = BuildLaunchCommand(out exe, out args, out desc);
            if (!ok)
            {
                starting = false;
                UpdateStatusText("[ 启动失败 ] 找不到 dsh，请检查网络后重试", Color.Red);
                AppendLog("[错误] 未能在缓存中找到 dsh，且 npx 不可用（请确认已安装 Node.js）。");
                return;
            }

            AppendLog("[启动] " + desc);
            AppendLog("[命令] " + exe + " " + args);
            if (args.Contains("npx --yes @deepseek-ai/dsh"))
                AppendLog("[提示] 未检测到本机已安装的 dsh，将由 npx 自动下载安装（首次可能需要 1~3 分钟），请稍候…");

            try
            {
                // 准备日志文件（保留上一份为 .prev），助手自身的诊断信息也会写入该文件
                PrepLogFile();

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = exe;
                psi.Arguments = args;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.WorkingDirectory = workDir;
                // 注意：不再使用管道重定向！改由 cmd 把输出写入日志文件，
                // 这样即使退出本程序（保留服务运行），dsh 也不会因管道断裂而崩溃。

                dshProc = new Process();
                dshProc.StartInfo = psi;
                dshProc.EnableRaisingEvents = true;
                dshProc.Exited += OnProcExited;
                dshProc.Start();

                starting = true;
                manuallyStopped = false;
                autoOpenedFlag = 0;
                tailOffset = 0;
                lastOutputTime = DateTime.Now;
                phaseStart = DateTime.Now;
                startWaitDeadline = DateTime.Now.AddSeconds(150);
                UpdateStatusText("[ 启动中… ] 已拉起进程，等待服务就绪", Color.OrangeRed);
                StartHealthPolling();

                AppendLog("[信息] dsh 进程已启动 (PID " + dshProc.Id + ")，工作目录: " + workDir);
                AppendLog("[提示] 本窗口可随时最小化/关闭（驻留托盘）。即使退出本程序，dsh 服务也能独立继续运行。");
            }
            catch (Exception ex)
            {
                starting = false;
                UpdateStatusText("[ 启动失败 ] " + ex.Message, Color.Red);
                AppendLog("[错误] 启动失败: " + ex.Message);
            }
        }

        // 准备日志文件：上一份转存 .prev，重建空文件并写入启动头
        private void PrepLogFile()
        {
            try
            {
                if (!Directory.Exists(logDir)) Directory.CreateDirectory(logDir);
                if (File.Exists(logPath))
                {
                    try { File.Copy(logPath, logPath + ".prev", true); } catch { }
                }
                File.WriteAllText(logPath,
                    "=== DSH 桌面助手 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ===\r\n",
                    Encoding.UTF8);
            }
            catch { }
            tailOffset = 0;
        }

        // 通过 npm 全局更新 dsh，成功后自动继续启动服务（适配全局安装来源）
        private void StartGlobalUpdateThenStart()
        {
            try
            {
                PrepLogFile();
                AppendLog("[更新] 执行: npm install -g @deepseek-ai/dsh@latest （可能需要 1~2 分钟）");

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "cmd.exe";
                psi.Arguments = "/d /s /c \"npm install -g @deepseek-ai/dsh@latest >> \"" + logPath + "\" 2>&1\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.WorkingDirectory = workDir;

                dshProc = new Process();
                dshProc.StartInfo = psi;
                dshProc.EnableRaisingEvents = true;
                dshProc.Exited += delegate(object s, EventArgs e)
                {
                    int code = -1;
                    try { if (dshProc != null) code = dshProc.ExitCode; } catch { }
                    int fc = code;
                    OnUiThread(delegate
                    {
                        if (cancelStart) { starting = false; return; }
                        if (fc == 0)
                        {
                            AppendLog("[更新] 全局更新完成，正在启动服务…");
                            starting = false;
                            StartProcessCore();
                        }
                        else
                        {
                            starting = false;
                            UpdateStatusText("[ 更新失败 ] npm 退出码 " + fc + "，请查看日志", Color.Red);
                            AppendLog("[错误] 全局更新失败。可手动执行：npm install -g @deepseek-ai/dsh@latest 后重试一键启动。");
                        }
                    });
                };
                dshProc.Start();

                starting = true;
                manuallyStopped = false;
                autoOpenedFlag = 0;
                lastOutputTime = DateTime.Now;
                phaseStart = DateTime.Now;
                startWaitDeadline = DateTime.Now.AddSeconds(240);
                UpdateStatusText("[ 更新中… ] 正在通过 npm 更新全局 dsh", Color.OrangeRed);
                AppendLog("[信息] 更新进程已启动 (PID " + dshProc.Id + ")。");
            }
            catch (Exception ex)
            {
                starting = false;
                UpdateStatusText("[ 更新失败 ] " + ex.Message, Color.Red);
                AppendLog("[错误] 启动更新进程失败: " + ex.Message);
            }
        }

        // 构造启动命令：统一经 cmd 执行并把 stdout/stderr 重定向到日志文件。
        // 引号采用规范形态 /d /s /c "<整条命令>"：
        //   cmd 对裸 /c 多引号命令会"剥首尾引号"，破坏路径与重定向（实测 exit 1 且零输出）；
        //   /s 保证只剥离最外层一对引号，内部引号原样保留。
        private bool BuildLaunchCommand(out string exe, out string args, out string desc)
        {
            exe = "cmd.exe";

            // 方式0：检测到新版本，强制用 npx 获取最新版（--prefer-online 强制联网刷新缓存）
            if (forceNpx)
            {
                launchSource = "npx";
                args = "/d /s /c \"npx --yes --prefer-online @deepseek-ai/dsh web --no-open >> \"" + logPath + "\" 2>&1\"";
                desc = "检测到新版本，使用 npx 强制获取最新版并启动";
                return true;
            }

            // 方式1/2：在「npx 缓存」与「全局安装(npm -g / nvm)」之间选版本更高者
            string ver, source, cacheBin, globalCmd;
            GetBestInstall(out ver, out source, out cacheBin, out globalCmd);
            launchSource = source;

            if (source == "cache")
            {
                args = "/d /s /c \"" + Quote(FindNodeExe()) + " " + Quote(cacheBin) + " web --no-open >> \"" + logPath + "\" 2>&1\"";
                desc = "使用 npm 缓存中的 dsh " + (ver ?? "") + " (direct)";
                return true;
            }

            if (source == "global")
            {
                args = "/d /s /c \"" + Quote(globalCmd) + " web --no-open >> \"" + logPath + "\" 2>&1\"";
                desc = "使用全局安装的 dsh " + (ver ?? "");
                return true;
            }

            // 方式3：本机没有任何 dsh → 回退 npx 首次下载安装
            args = "/d /s /c \"npx --yes @deepseek-ai/dsh web --no-open >> \"" + logPath + "\" 2>&1\"";
            desc = "未找到本机 dsh，使用 npx 自动下载安装并启动";
            return true;
        }

        private static string Quote(string s) { return "\"" + s + "\""; }

        // 定位 node.exe：标准目录（含 nvm 符号链接）→ nvm 实际目录 → PATH
        private string FindNodeExe()
        {
            try
            {
                string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string lp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

                string std = Path.Combine(pf, "nodejs", "node.exe");   // 安装器目录或 nvm 符号链接
                if (File.Exists(std)) return std;

                // nvm-windows：%LOCALAPPDATA%\nvm\vX.Y.Z\node.exe（取最新）
                string nvmRoot = Path.Combine(lp, "nvm");
                if (Directory.Exists(nvmRoot))
                {
                    DirectoryInfo best = null;
                    foreach (DirectoryInfo d in new DirectoryInfo(nvmRoot).GetDirectories("v*"))
                    {
                        string ne = Path.Combine(d.FullName, "node.exe");
                        if (File.Exists(ne))
                        {
                            if (best == null || d.LastWriteTimeUtc > best.LastWriteTimeUtc) best = d;
                        }
                    }
                    if (best != null) return Path.Combine(best.FullName, "node.exe");
                }

                string alt = Path.Combine(lp, "Programs", "nodejs", "node.exe");
                if (File.Exists(alt)) return alt;
            }
            catch { }
            return "node";
        }

        private string DetectNodeDirect(out string ver)
        {
            ver = null;
            try
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string cacheRoot = Path.Combine(local, "npm-cache", "_npx");
                if (!Directory.Exists(cacheRoot)) return null;

                DirectoryInfo best = null;
                DirectoryInfo[] dirs = new DirectoryInfo(cacheRoot).GetDirectories();
                foreach (DirectoryInfo d in dirs)
                {
                    string pkg = Path.Combine(d.FullName, "node_modules", "@deepseek-ai", "dsh");
                    string bin = Path.Combine(pkg, "lib", "bin.js");
                    if (Directory.Exists(pkg) && File.Exists(bin))
                    {
                        if (best == null || d.LastWriteTimeUtc > best.LastWriteTimeUtc) best = d;
                    }
                }
                if (best == null) return null;
                string pkgDir = Path.Combine(best.FullName, "node_modules", "@deepseek-ai", "dsh");
                ver = ReadVersionFromPkg(Path.Combine(pkgDir, "package.json"));
                return Path.Combine(pkgDir, "lib", "bin.js");
            }
            catch { return null; }
        }

        private static string ReadVersionFromPkg(string pkgJsonPath)
        {
            try
            {
                if (!File.Exists(pkgJsonPath)) return null;
                Match m = Regex.Match(File.ReadAllText(pkgJsonPath, Encoding.UTF8), "\"version\"\\s*:\\s*\"([^\"]+)\"");
                return m.Success ? m.Groups[1].Value : null;
            }
            catch { return null; }
        }

        // 探测全局安装的 dsh（npm -g / nvm-windows），返回 dsh.cmd 全路径；ver 返回其版本
        private string DetectGlobalDsh(out string ver)
        {
            ver = null;
            try
            {
                string cmdPath = null;
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string lp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

                string[] candidates = new string[] {
                    Path.Combine(appData, "npm", "dsh.cmd"),          // 标准 npm 全局
                    Path.Combine(pf, "nodejs", "dsh.cmd")             // 部分安装形态
                };
                foreach (string c in candidates)
                    if (File.Exists(c)) { cmdPath = c; break; }

                if (cmdPath == null)
                {
                    // nvm-windows：%LOCALAPPDATA%\nvm\vX.Y.Z\dsh.cmd，取最新版本目录
                    string nvmRoot = Path.Combine(lp, "nvm");
                    if (Directory.Exists(nvmRoot))
                    {
                        DirectoryInfo best = null;
                        foreach (DirectoryInfo d in new DirectoryInfo(nvmRoot).GetDirectories("v*"))
                        {
                            string c = Path.Combine(d.FullName, "dsh.cmd");
                            if (File.Exists(c))
                            {
                                if (best == null || d.LastWriteTimeUtc > best.LastWriteTimeUtc) best = d;
                            }
                        }
                        if (best != null) cmdPath = Path.Combine(best.FullName, "dsh.cmd");
                    }
                }

                if (cmdPath == null)
                {
                    // 兜底：从 PATH 解析（where dsh）
                    try
                    {
                        ProcessStartInfo wpsi = new ProcessStartInfo("where.exe", "dsh");
                        wpsi.UseShellExecute = false;
                        wpsi.CreateNoWindow = true;
                        wpsi.RedirectStandardOutput = true;
                        using (Process wp = Process.Start(wpsi))
                        {
                            string so = wp.StandardOutput.ReadToEnd();
                            wp.WaitForExit(3000);
                            foreach (string ln in so.Split('\n'))
                            {
                                string t = (ln ?? "").Trim();
                                if (t.EndsWith("dsh.cmd", StringComparison.OrdinalIgnoreCase) && File.Exists(t))
                                {
                                    cmdPath = t;
                                    break;
                                }
                            }
                        }
                    }
                    catch { }
                }

                if (cmdPath == null) return null;

                // 版本号：<prefix>\node_modules\@deepseek-ai\dsh\package.json
                string prefix = Path.GetDirectoryName(cmdPath);
                ver = ReadVersionFromPkg(Path.Combine(prefix, "node_modules", "@deepseek-ai", "dsh", "package.json"));
                return cmdPath;
            }
            catch { return null; }
        }

        // 综合选择最佳安装来源：
        //   installMode=auto  → 缓存与全局中版本更高者（相同优先缓存，启动更快）
        //   installMode=global → 优先全局；全局没有但有缓存时临时用缓存
        //   installMode=cache  → 优先缓存；缓存没有但有全局时临时用全局
        private void GetBestInstall(out string ver, out string source, out string cacheBin, out string globalCmd)
        {
            string cv = null, gv = null;
            cacheBin = DetectNodeDirect(out cv);
            globalCmd = DetectGlobalDsh(out gv);

            if (installMode == "global")
            {
                if (globalCmd != null) { ver = gv; source = "global"; }
                else if (cacheBin != null) { ver = cv; source = "cache"; }
                else { ver = null; source = null; }
                return;
            }

            if (installMode == "cache")
            {
                if (cacheBin != null) { ver = cv; source = "cache"; }
                else if (globalCmd != null) { ver = gv; source = "global"; }
                else { ver = null; source = null; }
                return;
            }

            // auto
            if (cacheBin != null && (globalCmd == null || !IsNewerVersion(gv, cv)))
            {
                ver = cv; source = "cache";
            }
            else if (globalCmd != null)
            {
                ver = gv; source = "global";
            }
            else
            {
                ver = null; source = null;
            }
        }

        // 当前最佳来源的 dsh 版本（缓存与全局中取版本更高者）
        private string InstalledDshVersion()
        {
            string ver, source, cb, gc;
            GetBestInstall(out ver, out source, out cb, out gc);
            return ver;
        }

        // 从 npm 源查询 dsh 最新版本（失败返回 null）
        private string LatestDshVersion()
        {
            try
            {
                string registry = ResolveRegistry();
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(registry.TrimEnd('/') + "/@deepseek-ai/dsh/latest");
                req.Method = "GET";
                req.Timeout = 8000;
                req.UserAgent = "DSHDesktop/1.0";
                req.Accept = "application/json";
                string json;
                using (HttpWebResponse rsp = (HttpWebResponse)req.GetResponse())
                using (Stream s = rsp.GetResponseStream())
                using (StreamReader sr = new StreamReader(s, Encoding.UTF8))
                    json = sr.ReadToEnd();
                Match m = Regex.Match(json, "\"version\"\\s*:\\s*\"([^\"]+)\"");
                return m.Success ? m.Groups[1].Value : null;
            }
            catch { return null; }
        }

        // 解析 npm 镜像源：优先环境变量 / .npmrc 的 registry，否则官方源
        private string ResolveRegistry()
        {
            const string DefaultRegistry = "https://registry.npmjs.org";
            try
            {
                string env = Environment.GetEnvironmentVariable("npm_config_registry");
                if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
                string npmrc = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".npmrc");
                if (File.Exists(npmrc))
                {
                    string[] lines = File.ReadAllLines(npmrc, Encoding.UTF8);
                    foreach (string line in lines)
                    {
                        string t = (line ?? "").Trim();
                        if (t.Length > 9 && t.StartsWith("registry=", StringComparison.OrdinalIgnoreCase))
                            return t.Substring(9).Trim();
                    }
                }
            }
            catch { }
            return DefaultRegistry;
        }

        // 语义化比较：latest 是否比 installed 新（比较主/次/修订号，忽略 -rc 后缀差异）
        private static bool IsNewerVersion(string latest, string installed)
        {
            if (string.IsNullOrEmpty(latest) || string.IsNullOrEmpty(installed)) return false;
            int[] a = ParseVersionBase(latest);
            int[] b = ParseVersionBase(installed);
            for (int i = 0; i < 3; i++)
            {
                if (a[i] != b[i]) return a[i] > b[i];
            }
            return false;
        }

        private static int[] ParseVersionBase(string v)
        {
            string basePart = v;
            int idx = basePart.IndexOf('-');
            if (idx >= 0) basePart = basePart.Substring(0, idx);
            string[] parts = basePart.Split('.');
            int[] res = new int[3] { 0, 0, 0 };
            for (int i = 0; i < parts.Length && i < 3; i++)
            {
                int n;
                if (int.TryParse(parts[i], out n)) res[i] = n;
            }
            return res;
        }

        // ---------------- 停止服务 ----------------
        private bool IsDshAliveByProcessOrPort()
        {
            if (dshProc != null && !dshProc.HasExited) return true;
            return FindListenerPid(port) > 0;
        }

        private void StopService()
        {
            // 记录是否处于"更新检查等待中"（还没拉起进程）
            bool wasPending = starting && (dshProc == null || dshProc.HasExited);
            cancelStart = true; // 取消待执行的启动

            bool killed = false;
            int foundPid = 0;
            if (dshProc != null && !dshProc.HasExited)
            {
                AppendLog("[停止] 正在结束 dsh 及其子进程 (PID " + dshProc.Id + ")…");
                killed = KillTree(dshProc.Id);
            }

            if (!killed)
            {
                // 兼容：服务可能是由旧版助手实例或手动 PowerShell 拉起的，按端口定位 PID
                foundPid = FindListenerPid(port);
                if (foundPid > 0)
                {
                    string pname = GetProcessName(foundPid);
                    if (!IsPlausibleDshName(pname))
                    {
                        AppendLog("[停止] 端口 " + port + " 的监听进程是 " + (pname ?? "<未知>") +
                            "（PID " + foundPid + "），不是 dsh/node，已跳过以免误杀。");
                        foundPid = -1; // 标记：端口被无关程序占用
                    }
                    else
                    {
                        AppendLog("[停止] 通过端口 " + port + " 定位到 dsh 进程（" + pname + "，PID " + foundPid + "），正在结束…");
                        killed = KillTree(foundPid);
                    }
                }
            }

            manuallyStopped = true;
            starting = false;
            StopHealthPolling();
            running = false;

            if (killed)
            {
                UpdateStatusText("[ 已停止 ] dsh 服务已停止", Color.DimGray);
                AppendLog("[信息] dsh 服务已停止。");
            }
            else if (wasPending)
            {
                UpdateStatusText("[ 已取消 ] 已取消待执行的启动", Color.DimGray);
                AppendLog("[信息] 已取消启动（更新检查被中断）。");
            }
            else if (foundPid > 0)
            {
                UpdateStatusText("[ 停止失败 ] 无法结束 PID " + foundPid + "（可能需要管理员权限）", Color.Red);
                AppendLog("[错误] 停止失败：进程 " + foundPid + " 未能结束。可尝试以管理员身份运行本程序，或在任务管理器中手动结束该 node 进程。详见上方 taskkill 诊断。");
            }
            else
            {
                AppendLog("[信息] 当前没有正在运行的 dsh 服务。");
            }
        }

        private bool KillTree(int pid)
        {
            // 方式1：taskkill（捕获输出，失败可诊断）
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "taskkill.exe";
                psi.Arguments = "/PID " + pid + " /T /F";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    string so = p.StandardOutput.ReadToEnd();
                    string se = p.StandardError.ReadToEnd();
                    p.WaitForExit(8000);
                    int code = p.ExitCode;
                    string detail = (so.Trim().Length > 0 ? "；输出: " + so.Trim() : "") +
                                    (se.Trim().Length > 0 ? "；错误: " + se.Trim() : "");
                    AppendLogSafe("[停止] taskkill 退出码 " + code + detail);
                    if (code == 0) return true;
                }
            }
            catch (Exception ex) { AppendLogSafe("[停止] taskkill 异常: " + ex.Message); }

            // 方式2：PowerShell 递归杀进程树兜底（taskkill 失败时）
            try
            {
                string ps = "-NoProfile -Command \"$root=" + pid + "; $ids=@($root); " +
                            "$all=Get-CimInstance Win32_Process; " +
                            "do { $m=@($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId }); " +
                            "if ($m.Count -eq 0) { break }; " +
                            "$ids += @($m | ForEach-Object { [int]$_.ProcessId }) } while ($true); " +
                            "$ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; exit 0\"";
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "powershell.exe";
                psi.Arguments = ps;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    p.StandardOutput.ReadToEnd();
                    p.StandardError.ReadToEnd();
                    p.WaitForExit(15000);
                    int code = p.ExitCode;
                    AppendLogSafe("[停止] PowerShell 兜底退出码 " + code);
                    if (code == 0) return true;
                }
            }
            catch (Exception ex) { AppendLogSafe("[停止] PowerShell 兜底异常: " + ex.Message); }

            return false;
        }

        // 用 netstat 找出监听指定端口的进程 PID（0=未找到）
        private int FindListenerPid(int listenPort)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "netstat.exe";
                psi.Arguments = "-ano -p tcp";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);
                    // 形如: TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    12345（兼容 IPv6 [::]:3080）
                    string pattern = "^\\s*TCP\\s+\\S*:" + listenPort + "\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$";
                    Match m = Regex.Match(output, pattern, RegexOptions.Multiline);
                    if (m.Success)
                    {
                        int pid;
                        if (int.TryParse(m.Groups[1].Value, out pid)) return pid;
                    }
                }
            }
            catch { }
            return 0;
        }

        // 获取进程名（失败返回 null）
        private static string GetProcessName(int pid)
        {
            try { using (Process p = Process.GetProcessById(pid)) return p.ProcessName; }
            catch { return null; }
        }

        // 判断进程名是否属于 dsh/node 家族（防止误杀占用端口的无关程序）
        private static bool IsPlausibleDshName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string l = name.ToLowerInvariant();
            return l == "node" || l == "cmd" || l == "npm" || l.StartsWith("node");
        }

        // ---------------- 进程退出 ----------------
        private void OnProcExited(object sender, EventArgs e)
        {
            try
            {
            // 用 sender（真正退出的那个 Process 对象）读退出码，
            // 避免与字段 dshProc 被替换/置空产生竞态
            Process exited = sender as Process;
            int code = -1;
            try { if (exited != null) code = exited.ExitCode; } catch { }
            bool man = manuallyStopped;
            bool wasStarting = starting;
            int fc = code;

            // 修复：此事件在后台线程触发，必须回到 UI 线程更新界面
            OnUiThread(delegate
            {
                starting = false;
                StopHealthPolling();
                running = false;
                if (man)
                {
                    UpdateStatusText("[ 已停止 ] dsh 服务已停止", Color.DimGray);
                    AppendLog("[信息] dsh 进程已退出。");
                }
                else if (wasStarting || fc != 0)
                {
                    UpdateStatusText("[ 服务异常退出 ] 退出码 " + fc + "，请查看日志", Color.Red);
                    AppendLog("[错误] dsh 进程异常退出（退出码 " + fc + "）。常见原因：" +
                        "① Node.js 未安装或不在 PATH；② 首次 npx 下载失败（网络）；③ 端口被占用；④ 工作目录不存在。");
                }
                else
                {
                    AppendLog("[信息] dsh 进程已退出（退出码 " + fc + "）。");
                }
            });
            }
            catch (Exception ex)
            {
                AppendLogSafe("[错误] 进程退出处理异常: " + ex.Message);
            }
        }

        // ---------------- 健康检查 ----------------
        private void StartHealthPolling()
        {
            StopHealthPolling();
            healthTimer = new System.Threading.Timer(delegate(object state) { CheckHealth(); }, null, 1500, 2000);
        }

        private void StopHealthPolling()
        {
            if (healthTimer != null)
            {
                System.Threading.Timer t = healthTimer;
                healthTimer = null;
                t.Dispose();
            }
        }

        private void CheckHealth()
        {
            // 防重入：上一轮还没查完就不开新一轮
            if (Interlocked.CompareExchange(ref healthBusy, 1, 0) != 0) return;
            try
            {
                string url = "http://127.0.0.1:" + port + "/";
                bool alive = IsAlive(url);
                if (alive)
                {
                    // 立即停止轮询：防止后续 tick 再排队"就绪回调"，导致重复打开浏览器
                    StopHealthPolling();
                    // 跨线程一次性闸门：并发到达的多个路径中，只有一个能拿到 first=true
                    bool isFirstReady = Interlocked.CompareExchange(ref autoOpenedFlag, 1, 0) == 0;
                    OnUiThread(delegate
                    {
                        starting = false;
                        running = true;
                        UpdateStatusText("[ 运行中 ] dsh 已就绪  " + url, Color.ForestGreen);
                        AppendLog("[就绪] dsh 服务已就绪: " + url);
                        if (autoOpenBrowser && isFirstReady)
                        {
                            ShowBalloon("dsh 服务已就绪", "浏览器即将打开 " + url);
                            OpenBrowser(true);
                        }
                    });
                }
                else if (manuallyStopped)
                {
                    StopHealthPolling();
                }
            }
            catch (Exception ex)
            {
                // Timer 回调里的任何意外都不能带崩整个进程
                AppendLogSafe("[错误] 健康检查异常: " + ex.Message);
            }
            finally
            {
                Interlocked.Exchange(ref healthBusy, 0);
            }
        }

        private void OnUiThread(Action a)
        {
            try
            {
                if (IsHandleCreated && !IsDisposed) BeginInvoke(a);
            }
            catch { }
        }

        private void ShowBalloon(string title, string text)
        {
            try
            {
                if (tray != null)
                {
                    tray.BalloonTipTitle = title;
                    tray.BalloonTipText = text;
                    tray.BalloonTipIcon = ToolTipIcon.Info;
                    tray.ShowBalloonTip(5000);
                }
            }
            catch { }
        }

        // ---------------- 日志文件跟踪 ----------------
        private void TailLog()
        {
            try
            {
                if (logPath == null || !File.Exists(logPath)) return;
                using (FileStream fs = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    if (fs.Length < tailOffset)
                    {
                        tailOffset = 0;
                        AppendRaw("\r\n[日志已重建]\r\n");
                    }
                    if (fs.Length == tailOffset) return;
                    fs.Seek(tailOffset, SeekOrigin.Begin);
                    int remain = (int)Math.Min(fs.Length - tailOffset, 256 * 1024);
                    byte[] buf = new byte[remain];
                    int total = 0;
                    while (total < remain)
                    {
                        int n = fs.Read(buf, total, remain - total);
                        if (n <= 0) break;
                        total += n;
                    }
                    // 防止 UTF-8 多字节字符跨块边界被截断：末尾不完整序列留到下一轮
                    int trailing = 0;
                    while (trailing < 3 && total - trailing > 0)
                    {
                        byte b = buf[total - 1 - trailing];
                        if ((b & 0xC0) == 0x80) { trailing++; continue; }   // 连续字节，继续回溯
                        int need = 1;
                        if ((b & 0x80) != 0)
                            need = ((b & 0xF0) == 0xF0) ? 4 : (((b & 0xE0) == 0xE0) ? 3 : 2);
                        trailing = (need > trailing + 1) ? (trailing + 1) : 0;
                        break;
                    }
                    tailOffset += total - trailing;
                    if (total > trailing)
                    {
                        lastOutputTime = DateTime.Now; // 子进程确实有输出 → 用于超时续期判断
                        AppendRaw(Encoding.UTF8.GetString(buf, 0, total - trailing));
                    }

                }
            }
            catch { }
        }

        private void OpenLogsFolder()
        {
            try
            {
                if (!Directory.Exists(logDir)) Directory.CreateDirectory(logDir);
                if (File.Exists(logPath))
                    Process.Start("explorer.exe", "/select,\"" + logPath + "\"");
                else
                    Process.Start("explorer.exe", logDir);
            }
            catch (Exception ex) { AppendLog("[错误] 打开日志文件夹失败: " + ex.Message); }
        }

        // ---------------- 浏览器 ----------------
        private void OpenBrowser(bool auto = false)
        {
            int p;
            if (int.TryParse(txtPort.Text, out p) && p > 0 && p <= 65535) port = p;
            string url = "http://127.0.0.1:" + port + "/";
            try
            {
                // 自动打开去重：3 秒内的第二次自动调用直接忽略（手动点击不受限）
                if (auto)
                {
                    DateTime now = DateTime.Now;
                    if ((now - lastAutoOpen).TotalSeconds < 3)
                    {
                        AppendLog("[提示] 检测到重复的自动打开请求，已忽略。");
                        return;
                    }
                    lastAutoOpen = now;
                }
                if (!IsAlive(url)) AppendLog("[提示] 服务尚未就绪：" + url + "（仍会尝试打开）");
                Process.Start(url);
                AppendLog("[打开] 已在默认浏览器中打开 " + url);
            }
            catch (Exception ex) { AppendLog("[错误] 打开浏览器失败: " + ex.Message); }
        }

        // ---------------- 网络探测 ----------------
        private static bool IsAlive(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = 1800;
                req.AllowAutoRedirect = true;
                req.UserAgent = "DSHDesktop/1.0";
                using (HttpWebResponse rsp = (HttpWebResponse)req.GetResponse())
                {
                    return true;
                }
            }
            catch (WebException wex)
            {
                if (wex.Response != null) return true;
                return false;
            }
            catch { return false; }
        }

        // ---------------- 设置持久化 ----------------
        private void LoadSettings()
        {
            try
            {
                if (!File.Exists(settingsFile)) return;
                string[] lines = File.ReadAllLines(settingsFile, Encoding.UTF8);
                foreach (string line in lines)
                {
                    int idx = line.IndexOf('=');
                    if (idx <= 0) continue;
                    string k = line.Substring(0, idx).Trim();
                    string v = line.Substring(idx + 1).Trim();
                    if (k == "port") { int p; if (int.TryParse(v, out p) && p > 0 && p <= 65535) port = p; }
                    else if (k == "workdir" && v.Length > 0) workDir = v;
                    else if (k == "autoOpen") autoOpenBrowser = (v == "1");
                    else if (k == "autoStart") autoStartService = (v == "1");
                    else if (k == "autoUpdate") autoUpdate = (v == "1");
                    else if (k == "installMode" && (v == "auto" || v == "global" || v == "cache")) installMode = v;
                }
            }
            catch { }
        }

        private void SaveSettings()
        {
            try
            {
                if (!Directory.Exists(settingsDir)) Directory.CreateDirectory(settingsDir);
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("port=" + port);
                sb.AppendLine("workdir=" + workDir);
                sb.AppendLine("autoOpen=" + (autoOpenBrowser ? "1" : "0"));
                sb.AppendLine("autoStart=" + (autoStartService ? "1" : "0"));
                sb.AppendLine("autoUpdate=" + (autoUpdate ? "1" : "0"));
                sb.AppendLine("installMode=" + installMode);
                File.WriteAllText(settingsFile, sb.ToString(), Encoding.UTF8);

                // 开机自启（注册表 HKCU Run）
                try
                {
                    Microsoft.Win32.RegistryKey rk = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
                    if (rk != null)
                    {
                        if (autoStartService)
                            rk.SetValue("DSHDesktop", "\"" + Application.ExecutablePath + "\" -autostart");
                        else
                            rk.DeleteValue("DSHDesktop", false);
                    }
                }
                catch (Exception ex) { AppendLogSafe("[警告] 设置开机自启失败: " + ex.Message); }
            }
            catch { }
        }

        // ---------------- 界面辅助 ----------------
        private void UpdateStatusText(string text, Color color)
        {
            try
            {
                lblStatus.Text = text;
                lblStatus.ForeColor = color;
                if (tray != null) tray.Text = text.Length > 62 ? text.Substring(0, 62) : text;
            }
            catch { }
        }

        // 助手自身消息：统一写入日志文件（磁盘留证），界面由 TailLog 统一刷新显示
        private void AppendLog(string line)
        {
            try
            {
                string full = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line + "\r\n";
                try
                {
                    if (!Directory.Exists(logDir)) Directory.CreateDirectory(logDir);
                    lock (logLock) { File.AppendAllText(logPath, full, Encoding.UTF8); }
                }
                catch { }
            }
            catch { }
        }

        private void AppendRaw(string text)
        {
            try
            {
                if (txtLog == null || txtLog.IsDisposed) return;
                TrimLogIfNeeded();
                txtLog.AppendText(text);
            }
            catch { }
        }

        private void AppendLogSafe(string text) { OnUiThread(delegate { AppendLog(text); }); }

        private void TrimLogIfNeeded()
        {
            try
            {
                if (txtLog.TextLength > 60000) txtLog.Clear();
            }
            catch { }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // 系统级关闭必须放行：否则会阻碍 Windows 关机/注销，
            // 并可能被系统超时强杀——外部表现就是"程序自动消失"
            bool systemClose =
                e.CloseReason == CloseReason.WindowsShutDown ||
                e.CloseReason == CloseReason.TaskManagerClosing ||
                e.CloseReason == CloseReason.ApplicationExitCall ||
                e.CloseReason == CloseReason.FormOwnerClosing;

            // 仅拦截用户点击标题栏 X 的场景：最小化到托盘而不是退出
            if (!forceExit && !systemClose && !e.Cancel)
            {
                ApplyUiSettings(); // 关闭前把设置落盘（修复：勾选不点启动也会丢）
                e.Cancel = true;
                Hide();
                if (running)
                    ShowBalloon("DSH 桌面助手", "已最小化到系统托盘，dsh 服务在后台继续运行。");
                else
                    ShowBalloon("DSH 桌面助手", "已最小化到系统托盘（右键托盘图标可操作）。");
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (tray != null)
                {
                    tray.Visible = false;
                    tray.Dispose();
                }
                if (uiTimer != null) { uiTimer.Stop(); uiTimer.Dispose(); }
                StopHealthPolling();
            }
            base.Dispose(disposing);
        }
    }
}
