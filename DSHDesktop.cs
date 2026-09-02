using System;
using System.Collections.Generic;
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

        // 崩溃转储：exe 旁 data\logs\crash-时间.log（无便携目录则 %APPDATA%）
        internal static void WriteCrashLog(string kind, Exception ex)
        {
            try
            {
                string dataDir = MainForm.ResolveDataDir();
                string dir = Path.Combine(dataDir, "logs");
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
        // 无 BOM 的 UTF-8：写 JSON / ini 配置文件必须无 BOM（.NET Encoding.UTF8 默认带 BOM，
        // Node JSON.parse 会因 BOM 字符失败——网关启动失败根因，修复 N1）
        private static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

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
        private Process gwProc = null;                     // 模型网关进程
        private int gwPort = 3090;                          // 网关监听端口
        private string gwKey = "";                          // 网关统一 key（留空则随机生成）
        private string gwConfigPath = "";                   // gateway.config.json 路径
        private bool gwTimerEnabled = false;               // 网关状态轮询开关（UI 构建后开启）
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
        private Button btnGwStart, btnGwStop, btnGwWrite, btnGwAdd, btnGwDel, btnGwSave, btnGwReload, btnGwOpen;
        private Label lblGwStatus, lblGwHint;
        private TextBox txtGwPort, txtGwKey, txtGwUA;
        private string gwClientUA = "";                    // 上游请求 UA 覆盖（P3）：空=透传 dsh UA
        private DataGridView gvProviders;
        private NotifyIcon tray;
        private ContextMenuStrip trayMenu;
        private ToolStripMenuItem miStart, miOpen, miStop, miShow, miLog, miExit;
        private StatusStrip statusStrip;

        // 解析数据目录：优先 exe 旁 data\（绿色便携），不可写则回退 %APPDATA%\DSHDesktop；
        // 存在旧 %APPDATA% 数据时一次性迁移到新位置（幂等，迁移后不删除旧副本）。
        internal static string ResolveDataDir()
        {
            // 显式覆盖：DSH_DATA_DIR 环境变量优先（也便于测试与高级用户在任意位置放置数据）
            try
            {
                string overrideDir = Environment.GetEnvironmentVariable("DSH_DATA_DIR");
                if (!string.IsNullOrWhiteSpace(overrideDir))
                {
                    if (!Directory.Exists(overrideDir)) Directory.CreateDirectory(overrideDir);
                    string p = Path.Combine(overrideDir, ".write-test");
                    File.WriteAllText(p, "1"); File.Delete(p);
                    return overrideDir;
                }
            }
            catch { }

            string portable = null;
            try
            {
                string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
                if (!string.IsNullOrEmpty(exeDir))
                {
                    portable = Path.Combine(exeDir, "data");
                    if (!Directory.Exists(portable)) Directory.CreateDirectory(portable);
                    // 可写性探测：尝试创建临时文件
                    string probe = Path.Combine(portable, ".write-test");
                    File.WriteAllText(probe, "1");
                    File.Delete(probe);
                }
            }
            catch { portable = null; }

            if (portable != null)
            {
                // 迁移：便携 data 刚创建且为空时，把 %APPDATA% 旧数据复制过来
                try
                {
                    string legacy = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DSHDesktop");
                    if (Directory.Exists(legacy))
                    {
                        bool needsMigrate = false;
                        foreach (string f in new string[] { "settings.ini", "gateway.config.json" })
                        {
                            string src = Path.Combine(legacy, f);
                            string dst = Path.Combine(portable, f);
                            if (File.Exists(src) && !File.Exists(dst)) { File.Copy(src, dst, false); needsMigrate = true; }
                        }
                        string srcLog = Path.Combine(legacy, "logs");
                        string dstLog = Path.Combine(portable, "logs");
                        if (Directory.Exists(srcLog) && !Directory.Exists(dstLog))
                        {
                            Directory.CreateDirectory(dstLog);
                            foreach (string f in Directory.GetFiles(srcLog))
                            {
                                try { File.Copy(f, Path.Combine(dstLog, Path.GetFileName(f)), false); } catch { }
                            }
                        }
                        if (needsMigrate)
                            System.Diagnostics.Debug.WriteLine("[data] migrated from " + legacy);
                    }
                }
                catch { }
                return portable;
            }
            // 回退：%APPDATA%
            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DSHDesktop");
            try { if (!Directory.Exists(fallback)) Directory.CreateDirectory(fallback); } catch { }
            return fallback;
        }

        public MainForm(bool autoStartFlag)
        {
            Text = "DSH 桌面助手";
            ClientSize = new Size(760, 640);
            MinimumSize = new Size(690, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9F);

            // 解析数据目录：优先 exe 旁 data\（绿色便携），不可写则回退 %APPDATA%\DSHDesktop，
            // 并把旧 %APPDATA% 数据一次性迁移到新位置。
            settingsDir = ResolveDataDir();
            settingsFile = Path.Combine(settingsDir, "settings.ini");
            logDir = Path.Combine(settingsDir, "logs");
            logPath = Path.Combine(logDir, "dsh-web.log");
            gwConfigPath = Path.Combine(settingsDir, "gateway.config.json");

            // 界面只显示本次会话的日志：跳过磁盘上已有历史，避免打开窗口时刷出上次的日志
            try { if (File.Exists(logPath)) tailOffset = new FileInfo(logPath).Length; } catch { }

            LoadSettings();

            // 默认工作目录：未配置时使用用户主目录（开源通用化，不再硬编码开发机路径）
            if (string.IsNullOrEmpty(workDir))
                workDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

            BuildUi();
            BuildTray();

            // 网关面板就绪后启用状态轮询
            gwTimerEnabled = true;
            // 初始探测（后台），让状态灯尽快反映真实状态
            System.Threading.ThreadPool.QueueUserWorkItem(delegate(object st)
            {
                bool running = GatewayIsRunning();
                gwRunningCached = running;
                gwCacheTime = DateTime.Now;
                OnUiThread(delegate { SetGwStatus(running); });
            });

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

        // ---------- UI（网关）----------
        private bool gwRunningCached = false;          // 网关运行状态缓存（后台轮询填充）
        private DateTime gwCacheTime = DateTime.MinValue;
        private int gwProbing = 0;                     // 网关后台探测防重入闸

        private void BuildUi()
        {
            SuspendLayout();

            // ============ TabControl：dsh 服务 / 模型网关 ============
            TabControl tabs = new TabControl();
            tabs.SetBounds(12, 8, 736, 606);
            tabs.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            tabs.Font = new Font("Microsoft YaHei UI", 9F);

            // ---------- Tab1: dsh 服务 ----------
            TabPage tpService = new TabPage("dsh 服务");
            tpService.Padding = new Padding(0);

            btnStart = new Button();
            btnStart.Text = "一键启动";
            btnStart.Width = 110; btnStart.Height = 36; btnStart.Left = 16; btnStart.Top = 16;
            btnStart.BackColor = Color.FromArgb(0, 120, 212); btnStart.ForeColor = Color.White;
            btnStart.FlatStyle = FlatStyle.Flat;
            btnStart.Click += OnStartClick;

            btnOpen = new Button();
            btnOpen.Text = "打开浏览器";
            btnOpen.Width = 110; btnOpen.Height = 36; btnOpen.Left = 134; btnOpen.Top = 16;
            btnOpen.FlatStyle = FlatStyle.Flat;
            btnOpen.Click += OnOpenClick;

            btnStop = new Button();
            btnStop.Text = "停止服务";
            btnStop.Width = 110; btnStop.Height = 36; btnStop.Left = 252; btnStop.Top = 16;
            btnStop.FlatStyle = FlatStyle.Flat;
            btnStop.Click += OnStopClick;

            Label lblUrl = new Label();
            lblUrl.Text = "访问地址:";
            lblUrl.SetBounds(400, 22, 70, 22);
            TextBox txtUrl = new TextBox();
            txtUrl.Text = "http://127.0.0.1:" + port + "/";
            txtUrl.ReadOnly = true;
            txtUrl.SetBounds(468, 20, 250, 24);
            txtUrl.BorderStyle = BorderStyle.FixedSingle;

            GroupBox gb = new GroupBox();
            gb.Text = "设置";
            gb.SetBounds(16, 62, 702, 124);
            gb.BackColor = Color.White;

            Label l1 = new Label(); l1.Text = "端口:"; l1.SetBounds(16, 28, 50, 22);
            txtPort = new TextBox(); txtPort.Text = port.ToString(); txtPort.SetBounds(66, 25, 76, 24); txtPort.BorderStyle = BorderStyle.FixedSingle;
            Label l2 = new Label(); l2.Text = "工作目录:"; l2.SetBounds(170, 28, 60, 22);
            txtWorkDir = new TextBox(); txtWorkDir.Text = workDir; txtWorkDir.SetBounds(235, 25, 380, 24); txtWorkDir.BorderStyle = BorderStyle.FixedSingle;
            Button btnBrowse = new Button(); btnBrowse.Text = "..."; btnBrowse.SetBounds(622, 24, 44, 26);
            btnBrowse.Click += delegate { FolderBrowserDialog d = new FolderBrowserDialog(); d.Description = "选择 dsh 工作目录（一般是你的项目文件夹）"; d.SelectedPath = txtWorkDir.Text; if (d.ShowDialog(this) == DialogResult.OK) txtWorkDir.Text = d.SelectedPath; };

            chkAutoOpen = new CheckBox(); chkAutoOpen.Text = "服务就绪后自动打开浏览器"; chkAutoOpen.SetBounds(16, 64, 220, 24); chkAutoOpen.Checked = autoOpenBrowser;
            chkAutoStart = new CheckBox(); chkAutoStart.Text = "开机自动启动（登录时自动运行并启动 dsh）"; chkAutoStart.SetBounds(250, 64, 300, 24); chkAutoStart.Checked = autoStartService;
            chkUpdate = new CheckBox(); chkUpdate.Text = "启动前自动检查 dsh 更新"; chkUpdate.SetBounds(16, 94, 200, 24); chkUpdate.Checked = autoUpdate;

            Label lInst = new Label(); lInst.Text = "安装方式:"; lInst.SetBounds(230, 96, 62, 20);
            cmbInstall = new ComboBox();
            cmbInstall.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbInstall.Items.AddRange(new object[] { "自动择优", "全局安装(npm -g)", "缓存安装(npx)" });
            cmbInstall.SelectedIndex = (installMode == "global") ? 1 : (installMode == "cache") ? 2 : 0;
            cmbInstall.SetBounds(294, 92, 170, 24);
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
            txtLog.SetBounds(16, 220, 702, 360);
            txtLog.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;

            tpService.Controls.AddRange(new Control[] { btnStart, btnOpen, btnStop, lblUrl, txtUrl, gb, l3, txtLog });

            // ---------- Tab2: 模型网关 ----------
            TabPage tpGateway = new TabPage("模型网关");
            tpGateway.Padding = new Padding(0);

            btnGwStart = new Button(); btnGwStart.Text = "启动网关"; btnGwStart.SetBounds(16, 14, 105, 30); btnGwStart.FlatStyle = FlatStyle.Flat;
            btnGwStart.Click += delegate { StartGateway(); };
            btnGwStop = new Button(); btnGwStop.Text = "停止网关"; btnGwStop.SetBounds(127, 14, 105, 30); btnGwStop.FlatStyle = FlatStyle.Flat;
            btnGwStop.Click += delegate { StopGateway(); };
            btnGwWrite = new Button(); btnGwWrite.Text = "写入 dsh 配置"; btnGwWrite.SetBounds(238, 14, 115, 30); btnGwWrite.FlatStyle = FlatStyle.Flat;
            btnGwWrite.Click += delegate { WriteGatewayToDsh(); };

            lblGwStatus = new Label();
            lblGwStatus.Text = "● 已停止";
            lblGwStatus.ForeColor = Color.DimGray;
            lblGwStatus.SetBounds(364, 18, 110, 20);

            Label lg1 = new Label(); lg1.Text = "端口:"; lg1.SetBounds(470, 18, 40, 20);
            txtGwPort = new TextBox(); txtGwPort.Text = gwPort.ToString(); txtGwPort.SetBounds(508, 15, 62, 24); txtGwPort.BorderStyle = BorderStyle.FixedSingle;
            Label lg2 = new Label(); lg2.Text = "统一Key:"; lg2.SetBounds(576, 18, 54, 20);
            txtGwKey = new TextBox(); txtGwKey.Text = gwKey; txtGwKey.SetBounds(630, 15, 80, 24); txtGwKey.BorderStyle = BorderStyle.FixedSingle; txtGwKey.PasswordChar = '●';

            // —— 供应商可视化编辑表 ——
            // 第 2 行（y=56）：上游请求UA（P3 客户端白名单绕过）——留空=透传 dsh 原始 UA（防屏蔽）
            Label lg3 = new Label(); lg3.Text = "请求UA(可选):"; lg3.SetBounds(16, 58, 90, 20);
            txtGwUA = new TextBox(); txtGwUA.Text = gwClientUA; txtGwUA.SetBounds(108, 55, 300, 24); txtGwUA.BorderStyle = BorderStyle.FixedSingle;
            Label lg4 = new Label(); lg4.Text = "留空=透传dsh标识；填 claude-cli/2.0.0 等可过客户端白名单检测"; lg4.SetBounds(416, 58, 300, 20);
            lg4.ForeColor = Color.FromArgb(120, 120, 120);

            Label lh = new Label(); lh.Text = "多供应商管理（同一模型多供应商时，网关自动探测可用性并按优先级路由、故障切换）：";
            lh.SetBounds(16, 82, 690, 16);
            lh.ForeColor = Color.FromArgb(80, 80, 80);

            gvProviders = new DataGridView();
            gvProviders.SetBounds(16, 100, 702, 360);
            // 修复 N3：高度固定（去 Bottom anchor），否则 TabPage 布局重算时 gv 溢出并遮挡下方按钮
            gvProviders.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            gvProviders.AllowUserToAddRows = false;
            gvProviders.AllowUserToDeleteRows = false;
            gvProviders.RowHeadersVisible = false;
            // 列宽用显式 Width（N4）：AutoSize Fill + MinimumWidth 组合会把列撑出表格出现滚动条，
            // 显式宽度按比例固定，窗口拉伸时表格变宽、列保持比例稳定。
            gvProviders.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.None;
            gvProviders.BackgroundColor = Color.White;
            gvProviders.BorderStyle = BorderStyle.FixedSingle;
            gvProviders.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize;
            gvProviders.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            gvProviders.MultiSelect = false;
            // 列定义：ID / 上游地址 / 上游Key / 模型列表 / 优先级 / 启用（勾选列用专用类型，不能改 TextBox 列的 CellTemplate）
            gvProviders.Columns.Add("cId", "供应商ID");
            gvProviders.Columns.Add("cUrl", "上游地址 (baseURL)");
            gvProviders.Columns.Add("cKey", "上游 Key");
            gvProviders.Columns.Add("cModels", "模型列表 (逗号分隔)");
            gvProviders.Columns.Add("cPriority", "优先级");
            DataGridViewCheckBoxColumn colEnabled = new DataGridViewCheckBoxColumn();
            colEnabled.HeaderText = "启用";
            colEnabled.Name = "cEnabled";
            gvProviders.Columns.Add(colEnabled);
            // 显式列宽（合计 ≈ 680 ≤ 702，无滚动条）：ID 窄 / baseURL 最宽 / Key 适中 / 模型列表次宽 / 优先级窄 / 启用最窄
            gvProviders.Columns[0].Width = 60;    // 供应商ID
            gvProviders.Columns[1].Width = 220;   // 上游地址（最宽）
            gvProviders.Columns[2].Width = 150;   // 上游 Key
            gvProviders.Columns[3].Width = 180;   // 模型列表
            gvProviders.Columns[4].Width = 40;    // 优先级
            gvProviders.Columns[5].Width = 30;    // 启用（勾选框）

            // —— 表格下面操作按钮行 ——
            btnGwAdd = new Button(); btnGwAdd.Text = "＋ 添加供应商"; btnGwAdd.SetBounds(16, 472, 105, 30); btnGwAdd.FlatStyle = FlatStyle.Flat;
            btnGwAdd.Click += delegate { GwAddRow(); };
            btnGwDel = new Button(); btnGwDel.Text = "－ 删除选中"; btnGwDel.SetBounds(127, 472, 105, 30); btnGwDel.FlatStyle = FlatStyle.Flat;
            btnGwDel.Click += delegate { GwDeleteRow(); };
            btnGwSave = new Button(); btnGwSave.Text = "💾 保存配置"; btnGwSave.SetBounds(238, 472, 105, 30); btnGwSave.BackColor = Color.FromArgb(0, 120, 212); btnGwSave.ForeColor = Color.White; btnGwSave.FlatStyle = FlatStyle.Flat;
            btnGwSave.Click += delegate { GwSaveToFile(); };
            btnGwReload = new Button(); btnGwReload.Text = "↻ 重新加载"; btnGwReload.SetBounds(349, 472, 105, 30); btnGwReload.FlatStyle = FlatStyle.Flat;
            btnGwReload.Click += delegate { LoadProvidersGrid(); };
            btnGwOpen = new Button(); btnGwOpen.Text = "打开配置文件"; btnGwOpen.SetBounds(460, 472, 120, 30); btnGwOpen.FlatStyle = FlatStyle.Flat;
            btnGwOpen.Click += delegate { EditGatewayConfig(); };

            lblGwHint = new Label();
            lblGwHint.Text = "提示：修改后点「保存配置」写入 gateway.config.json；重启网关生效。也可用「写入 dsh 配置」注册到 dsh。";
            lblGwHint.ForeColor = Color.FromArgb(120, 120, 120);
            lblGwHint.SetBounds(16, 510, 700, 20);
            // 修复 N3：不设 anchor（默认 None），TabPage 页面固定 576 高，避免布局重算时尺寸被扭曲（曾出现 1228px 宽、y=748）

            tpGateway.Controls.AddRange(new Control[] { btnGwStart, btnGwStop, btnGwWrite, lblGwStatus, lg1, txtGwPort, lg2, txtGwKey, lg3, txtGwUA, lg4, lh, gvProviders, btnGwAdd, btnGwDel, btnGwSave, btnGwReload, btnGwOpen, lblGwHint });

            tabs.TabPages.Add(tpService);
            tabs.TabPages.Add(tpGateway);

            statusStrip = new StatusStrip();
            lblStatus = new ToolStripStatusLabel();
            lblStatus.TextAlign = ContentAlignment.MiddleLeft;
            lblStatus.Font = new Font("Microsoft YaHei UI", 9F);
            lblStatus.Spring = true;
            statusStrip.Items.Add(lblStatus);
            statusStrip.Dock = DockStyle.Bottom;
            statusStrip.SizingGrip = false;

            Controls.AddRange(new Control[] { tabs, statusStrip });

            ResumeLayout(false);
            PerformLayout();
            LoadProvidersGrid();

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

            // 网关状态灯：读后台轮询缓存（绝不在此处发起 HTTP，避免阻塞 UI——修复 B1）
            if (lblGwStatus != null && gwTimerEnabled)
            {
                if (!gwRunningCached && (DateTime.Now - gwCacheTime).TotalSeconds > 3)
                {
                    // 缓存过期且当前显示"未运行"：后台重新探测一次（外部可能已启动网关）
                    if (Interlocked.CompareExchange(ref gwProbing, 1, 0) == 0)
                    {
                        System.Threading.ThreadPool.QueueUserWorkItem(delegate(object st)
                        {
                            try
                            {
                                bool running = GatewayIsRunning();
                                gwRunningCached = running;
                                gwCacheTime = DateTime.Now;
                                OnUiThread(delegate { SetGwStatus(running); });
                            }
                            finally { Interlocked.Exchange(ref gwProbing, 0); }
                        });
                    }
                }
                else
                {
                    SetGwStatus(gwRunningCached);
                }
            }

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

            // 网关端口与统一 key 同步持久化（修复 G2：修改后即使不点启动，关窗也不丢失）
            if (txtGwPort != null)
            {
                int gp;
                if (int.TryParse(txtGwPort.Text, out gp) && gp > 0 && gp <= 65535) gwPort = gp;
            }
            if (txtGwKey != null)
            {
                gwKey = txtGwKey.Text.Trim();
            }
            if (txtGwUA != null)
            {
                gwClientUA = txtGwUA.Text.Trim();
            }

            // 关窗前自动落盘供应商表格（修复 N2：编辑后直接关窗/退出不再丢数据）
            if (gvProviders != null && gvProviders.Rows.Count > 0)
            {
                try { GwSaveToFile(false); } catch { }
            }

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
                ThreadPool.QueueUserWorkItem(delegate(object st) { CheckThenStart(); });
                return;
            }

            StartProcessCore();
        }

        // 后台线程：联网对比 dsh 版本。发现新版则按来源更新后启动；否则按现有版本启动
        private void CheckThenStart()
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
                    StartProcessCore();
                    return;
                }
                if (newer)
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
                else
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

        // ---------------- 模型网关 ----------------
        private string GatewayDir()
        {
            string d = "";
            try { d = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "gateway"); }
            catch { }
            // 兼容开发/部署：若 exe 目录下无 gateway，尝试源码目录
            if (!File.Exists(Path.Combine(d, "model-gateway.mjs")))
            {
                string alt = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh-desktop", "gateway");
                if (File.Exists(Path.Combine(alt, "model-gateway.mjs"))) d = alt;
            }
            return d;
        }

        private bool GatewayIsRunning()
        {
            // 快速路径：我们启动的进程仍存活
            if (gwProc != null && !gwProc.HasExited) return true;
            return GatewayIsRunningHttpOnly();
        }

        // 纯 HTTP 探测：仅当 /health 返回 200 才算运行（用于等待就绪/权威判定）
        private bool GatewayIsRunningHttpOnly()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + gwPort + "/health");
                req.Method = "GET"; req.Timeout = 1200;
                using (HttpWebResponse rsp = (HttpWebResponse)req.GetResponse()) { return rsp.StatusCode == HttpStatusCode.OK; }
            }
            catch { return false; }
        }

        private void StartGateway()
        {
            try
            {
                // 先自动落盘表格中的供应商（修复 N2：用户编辑后直接点启动会被丢弃）
                if (gvProviders != null && gvProviders.Rows.Count > 0) GwSaveToFile(false);

                // 清理旧的 gwProc 对象（已退出的直接释放；仍在运行的先停掉再继续）
                if (gwProc != null)
                {
                    if (!gwProc.HasExited)
                    {
                        KillTreePrivate(gwProc.Id);
                        gwProc.WaitForExit(3000);
                    }
                    try { gwProc.Dispose(); } catch { }
                    gwProc = null;
                }

                int p; if (int.TryParse(txtGwPort.Text, out p) && p > 0 && p <= 65535) gwPort = p;
                txtGwPort.Text = gwPort.ToString();
                gwKey = txtGwKey.Text.Trim();
                if (txtGwUA != null) gwClientUA = txtGwUA.Text.Trim();
                SaveSettings();

                string dir = GatewayDir();
                string gwMjs = Path.Combine(dir, "model-gateway.mjs");
                if (!File.Exists(gwMjs)) { AppendLog("[错误] 找不到 model-gateway.mjs（应位于 " + dir + "）"); return; }

                // 首次运行：若配置不存在则生成模板并提示编辑
                if (!File.Exists(gwConfigPath))
                {
                    try
                    {
                        if (!Directory.Exists(Path.GetDirectoryName(gwConfigPath))) Directory.CreateDirectory(Path.GetDirectoryName(gwConfigPath));
                        File.Copy(Path.Combine(dir, "gateway.config.example.json"), gwConfigPath, true);
                        AppendLog("[网关] 已生成配置模板: " + gwConfigPath + "，请点击「编辑供应商」填入上游后重新启动网关");
                    }
                    catch (Exception ex) { AppendLog("[错误] 生成网关配置失败: " + ex.Message); }
                }

                // key 前置校验 + 同步：界面填的统一 key 写入 config，且必须是有效值（避免 change-me 默认值）
                if (!SyncGwKeyToConfig()) { return; }

                if (GatewayIsRunning()) { AppendLog("[网关] 网关已在运行 (http://127.0.0.1:" + gwPort + "/v1)"); SetGwStatus(true); return; }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "node.exe";
                psi.Arguments = "\"" + gwMjs + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.WorkingDirectory = dir;
                psi.EnvironmentVariables["DSH_GATEWAY_CONFIG"] = gwConfigPath;
                psi.EnvironmentVariables["DSH_GATEWAY_LOG"] = Path.Combine(logDir, "gateway.log");

                gwProc = new Process();
                gwProc.StartInfo = psi;
                gwProc.EnableRaisingEvents = true;
                gwProc.Exited += delegate(object s, EventArgs e) { OnUiThread(delegate { SetGwStatus(false); }); };
                gwProc.Start();
                AppendLog("[网关] 启动中 (PID " + gwProc.Id + ")，端口 " + gwPort + "，统一Key=" + (gwKey.Length > 4 ? gwKey.Substring(0, 4) + "***" : "(未设置)"));
                // 等待就绪：放到后台线程，避免阻塞 UI（修复 A1）
                System.Threading.ThreadPool.QueueUserWorkItem(delegate(object st)
                {
                    DateTime until = DateTime.Now.AddSeconds(6);
                    bool ready = false;
                    while (DateTime.Now < until)
                    {
                        // 注意：必须做真实 HTTP 探测（不能走 gwProc 快速路径——
                        // 进程刚启动但端口未必监听好），因此临时让快速路径失效
                        ready = GatewayIsRunningHttpOnly();
                        if (ready) break;
                        System.Threading.Thread.Sleep(300);
                    }
                    OnUiThread(delegate
                    {
                        SetGwStatus(ready);
                        AppendLog(ready
                            ? ("[网关] 就绪——统一接口 http://127.0.0.1:" + gwPort + "/v1（Authorization: Bearer <统一Key>）")
                            : "[网关] 未在预期时间内就绪，请查看日志 logs/gateway.log");
                    });
                });
            }
            catch (Exception ex)
            {
                AppendLog("[错误] 启动网关失败: " + ex.Message);
            }
        }

        // 把界面填的统一 key 与端口同步进 gateway.config.json；返回 false 表示配置不可用（应中止启动）
        // 修复 F8：网关监听端口取自 config 的 "port" 字段，必须与 UI 端口一致，否则 UI 探测/写 dsh 全部错位
        private bool SyncGwKeyToConfig()
        {
            try
            {
                if (!File.Exists(gwConfigPath))
                {
                    AppendLog("[网关] 缺失配置文件，无法同步。请先「编辑供应商」保存配置。");
                    return false;
                }
                string json = File.ReadAllText(gwConfigPath, Encoding.UTF8);

                // —— 端口同步（顶层 "port"，无锚定：该字段在整个配置中只出现在顶层，第一处即正确）——
                // 修复 F8+：单行 JSON 下 ^ 锚定会因串首 { 失配，改用无锚定匹配
                var portM = Regex.Match(json, "\"port\"\\s*:\\s*\\d+");
                if (portM.Success)
                {
                    json = json.Substring(0, portM.Index) + "\"port\": " + gwPort + json.Substring(portM.Index + portM.Length);
                }
                else
                {
                    // 顶层无 port：在首个顶层键前插入
                    var firstKey = Regex.Match(json, "\\s*\"", RegexOptions.RightToLeft);
                    if (firstKey.Success && firstKey.Index >= 0)
                    {
                        // 取串开头到首个顶层键前的空白边界：简单方案——在第一个 { 后插入
                        int brace = json.IndexOf('{');
                        if (brace >= 0)
                            json = json.Substring(0, brace + 1) + "\"port\": " + gwPort + "," + json.Substring(brace + 1);
                    }
                    else
                    {
                        json = "{\"port\": " + gwPort + "," + json.TrimStart().TrimStart('{');
                    }
                }

                // 稳健的顶层定位：先把 providers 数组体剔除（仅匹配数组内第一个 ]，供 provider 无嵌套数组的配置使用），
                // 剩下文本里第一个 "apiKey" 即顶层字段（不受单行/多行、缩进影响）。
                string jsonCore = Regex.Replace(json, "\"providers\"\\s*:\\s*\\[[\\s\\S]*?\\]", "\"providers\": []");
                var m = Regex.Match(jsonCore, "\"apiKey\"\\s*:\\s*\"([^\"]*)\"");
                if (!m.Success)
                {
                    AppendLog("[网关] gateway.config.json 顶层缺少 apiKey 字段，请先「编辑供应商」补充。");
                    return false;
                }
                string cfgKey = m.Groups[1].Value;

                // 界面 key 非空且与配置文件不一致时，写入配置文件。
                // 替换基于 jsonCore 中匹配到的字段片段（"apiKey":"..."）；apiKey 位于 providers 之前时，
                // json 与 jsonCore 在片段起始处完全一致，index 可直接用于原串。
                if (gwKey.Length > 0 && gwKey != cfgKey)
                {
                    var fm = Regex.Match(jsonCore, "\"apiKey\"\\s*:\\s*\"[^\"]*\"");
                    // 防御：若 apiKey 意外出现在 providers 之后，json 该位置与 jsonCore 不再等长，禁止替换并提示
                    int provIdx = json.IndexOf("\"providers\"", StringComparison.Ordinal);
                    if (provIdx >= 0 && fm.Index > provIdx)
                    {
                        AppendLog("[网关] gateway.config.json 中 apiKey 位于 providers 之后，无法安全同步。请将顶层 apiKey 移到 providers 之前。");
                        return false;
                    }
                    string escaped = gwKey.Replace("\\", "\\\\").Replace("\"", "\\\"");
                    string replacement = "\"apiKey\": \"" + escaped + "\"";
                    json = json.Substring(0, fm.Index) + replacement + json.Substring(fm.Index + fm.Length);
                    cfgKey = gwKey;
                    AppendLog("[网关] 已将界面统一 Key 同步到 gateway.config.json。");
                }

                // port 或 key 有变动才写盘（无 BOM——修复 N1：带 BOM 的 JSON 无法被 Node 解析）
                File.WriteAllText(gwConfigPath, json, Utf8NoBom);

                if (cfgKey.Length == 0 || cfgKey == "change-me" || cfgKey == "dsh-gateway-change-me")
                {
                    AppendLog("[网关] 统一 Key 未设置或仍为模板默认值，拒绝启动。请在界面填写统一 Key 或编辑 gateway.config.json。");
                    return false;
                }
                // providers 非空校验：匹配字段片段 "providers":[...]（单个 [ 到首个匹配的 ] 为数组体）
                var pm = Regex.Match(json, "\"providers\"\\s*:\\s*\\[([\\s\\S]*?)\\]");
                if (!pm.Success || string.IsNullOrWhiteSpace(pm.Groups[1].Value))
                {
                    AppendLog("[网关] gateway.config.json 的 providers 为空，拒绝启动。请先「编辑供应商」添加至少一个上游。");
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                AppendLog("[错误] 同步网关 key 失败: " + ex.Message);
                return false;
            }
        }

        private void StopGateway()
        {
            try
            {
                bool killed = false;
                if (gwProc != null && !gwProc.HasExited)
                {
                    KillTreePrivate(gwProc.Id);
                    killed = gwProc.HasExited;
                    gwProc = null;
                }
                // 兜底：按端口查找（兼容上次会话遗留进程），且必须与真实 PID 一致或经身份校验
                if (!killed)
                {
                    int pid = FindListenerPid(gwPort);
                    if (pid > 0)
                    {
                        string nm = GetProcessName(pid);
                        // 只允许结束 node 进程；若其 PID 正是我们启动的网关则直接结束，否则仍按进程名鉴权
                        if (IsPlausibleDshName(nm))
                        {
                            KillTreePrivate(pid);
                            killed = true;
                        }
                        else
                        {
                            AppendLog("[网关] 端口 " + gwPort + " 的进程是 " + (nm ?? "<未知>") + "（PID " + pid + "），不是 node，已跳过以免误杀。");
                        }
                    }
                }
                SetGwStatus(false);
                AppendLog(killed ? "[网关] 已停止。" : "[网关] 未发现运行中的网关进程。");
            }
            catch (Exception ex) { AppendLog("[错误] 停止网关失败: " + ex.Message); }
        }

        private void KillTreePrivate(int pid)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "taskkill.exe";
                psi.Arguments = "/PID " + pid + " /T /F";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi)) { p.WaitForExit(5000); }
            }
            catch { }
        }

        // —— 供应商可视化编辑：从 gateway.config.json 载入表格 ——
        // 用自研最小 JSON 解析（结构固定：{port,apiKey,providers:[{id,baseURL,apiKey,models[],priority,enabled}]}），
        // 避免依赖 System.Web.Extensions（在纯 csc 场景下加载不稳定）
        private class GwProviderRow
        {
            public string id = "";
            public string baseURL = "";
            public string apiKey = "";
            public List<string> models = new List<string>();
            public int priority = 1;
            public bool enabled = true;
        }

        // 极简 JSON 对象解析：返回 Dictionary<string,string>（值已按字符串读）；数组字段由调用方处理
        private void LoadProvidersGrid()
        {
            try
            {
                if (gvProviders == null) return;
                gvProviders.Rows.Clear();
                if (!File.Exists(gwConfigPath))
                {
                    lblGwHint.Text = "尚未创建 gateway.config.json —— 点击「保存配置」将生成默认模板。";
                    return;
                }
                string json = File.ReadAllText(gwConfigPath, Encoding.UTF8);
                var cfg = ParseJsonObject(json);
                if (cfg == null) { lblGwHint.Text = "配置文件解析失败（可能是 JSON 格式错误）。"; return; }

                if (cfg.ContainsKey("port")) { int p; if (int.TryParse(cfg["port"], out p) && p > 0) gwPort = p; txtGwPort.Text = gwPort.ToString(); }
                if (cfg.ContainsKey("apiKey")) { gwKey = cfg["apiKey"]; txtGwKey.Text = gwKey; }
                if (cfg.ContainsKey("clientUA")) { gwClientUA = cfg["clientUA"]; if (txtGwUA != null) txtGwUA.Text = gwClientUA; }

                // 提取 providers 数组
                List<string> provList = null;
                if (cfg.ContainsKey("providers")) provList = ParseJsonArrayItems(json, "providers");
                if (provList != null)
                {
                    foreach (string itemJson in provList)
                    {
                        var pd = ParseJsonObject(itemJson);
                        if (pd == null) continue;
                        GwProviderRow row = new GwProviderRow();
                        string v;
                        if (pd.TryGetValue("id", out v)) row.id = v;
                        if (pd.TryGetValue("baseURL", out v)) row.baseURL = v;
                        if (pd.TryGetValue("apiKey", out v)) row.apiKey = v;
                        if (pd.TryGetValue("priority", out v)) int.TryParse(v, out row.priority);
                        if (pd.TryGetValue("enabled", out v)) bool.TryParse(v, out row.enabled);
                        // models 是数组片段（如 ["a","b"]）→ 解析为元素列表；也可能用户以逗号串形式编辑 → 兼容
                        if (pd.TryGetValue("models", out v))
                        {
                            string tv = v.Trim();
                            if (tv.StartsWith("["))
                                row.models = ParseJsonPlainArray(tv);   // 直接解析顶层数组片段（K2 修正：不再用空字段名匹配）
                            else
                                row.models = SplitModels(tv);
                        }
                        gvProviders.Rows.Add(row.id, row.baseURL, row.apiKey, string.Join(",", row.models.ToArray()), row.priority, row.enabled);
                    }
                }
                lblGwHint.Text = "修改后点「保存配置」写入 gateway.config.json；重启网关生效。";
            }
            catch (Exception ex)
            {
                lblGwHint.Text = "加载配置失败：" + ex.Message;
            }
        }

        // 从 JSON 数组片段（形如 ["a","b"]）解析出字符串元素列表
        private static List<string> ParseJsonPlainArray(string s)
        {
            var list = new List<string>();
            if (string.IsNullOrEmpty(s)) return list;
            int i = 0;
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
            if (i >= s.Length || s[i] != '[') return list;
            i++;
            while (i < s.Length)
            {
                while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
                if (i >= s.Length) break;
                if (s[i] == ']') break;
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '"')
                {
                    string val = ParseJsonString(s, ref i);
                    if (val == null) break;
                    list.Add(val);
                }
                else i++;
            }
            return list;
        }

        // 分割模型列表（兼容逗号/中文逗号）
        private static List<string> SplitModels(string s)
        {
            var list = new List<string>();
            if (string.IsNullOrEmpty(s)) return list;
            foreach (string part in s.Split(new char[] { ',', '，' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string t = part.Trim();
                if (t.Length > 0) list.Add(t);
            }
            return list;
        }

        // 极简 JSON 顶层对象解析 → Dictionary<string,string>（嵌套对象/数组压缩为原始片段）
        private static Dictionary<string, string> ParseJsonObject(string json)
        {
            var result = new Dictionary<string, string>();
            if (string.IsNullOrEmpty(json)) return null;
            int i = 0;
            SkipWs(json, ref i);
            if (i >= json.Length || json[i] != '{') return null;
            i++;
            while (i < json.Length)
            {
                SkipWs(json, ref i);
                if (i >= json.Length) break;
                if (json[i] == '}') { i++; break; }
                if (json[i] == ',') { i++; continue; }
                string key = ParseJsonString(json, ref i);
                if (key == null) break;
                SkipWs(json, ref i);
                if (i < json.Length && json[i] == ':') i++;
                SkipWs(json, ref i);
                // 值：字符串 / 数字 / true / false / null / 对象 / 数组
                string val;
                if (i < json.Length && json[i] == '"') val = ParseJsonString(json, ref i);
                else if (i < json.Length && json[i] == '{') { int start = i; int end = SkipBalanced(json, i, '{', '}'); val = json.Substring(start, end - start); i = end; }
                else if (i < json.Length && json[i] == '[') { int start = i; int end = SkipBalanced(json, i, '[', ']'); val = json.Substring(start, end - start); i = end; }
                else { int start = i; while (i < json.Length && json[i] != ',' && json[i] != '}' && json[i] != '\r' && json[i] != '\n') i++; val = json.Substring(start, i - start).Trim(); }
                result[key] = val;
            }
            return result;
        }

        // 从对象 json 中提取指定数组字段的每个元素（原始 JSON 片段列表）
        private static List<string> ParseJsonArrayItems(string json, string field)
        {
            int idx = json.IndexOf("\"" + field + "\"", StringComparison.Ordinal);
            if (idx < 0) return null;
            idx += field.Length + 2;
            // 跳过冒号与空白
            while (idx < json.Length && (json[idx] == ':' || char.IsWhiteSpace(json[idx]))) idx++;
            if (idx >= json.Length || json[idx] != '[') return null;
            idx++;
            var items = new List<string>();
            while (idx < json.Length)
            {
                while (idx < json.Length && char.IsWhiteSpace(json[idx])) idx++;
                if (idx >= json.Length) break;
                if (json[idx] == ']') break;
                if (json[idx] == ',') { idx++; continue; }
                int start = idx;
                if (json[idx] == '{') idx = SkipBalanced(json, idx, '{', '}');
                else idx = SkipBalanced(json, idx, '[', ']');
                items.Add(json.Substring(start, idx - start));
            }
            return items;
        }

        private static int SkipBalanced(string s, int i, char open, char close)
        {
            int depth = 0;
            bool inStr = false;
            while (i < s.Length)
            {
                char c = s[i];
                if (c == '"' && (i == 0 || s[i - 1] != '\\')) inStr = !inStr;
                if (!inStr)
                {
                    if (c == open) depth++;
                    else if (c == close) { depth--; if (depth == 0) { i++; break; } }
                }
                i++;
            }
            return i;
        }

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        private static string ParseJsonString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') return null;
            i++;
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            while (i < s.Length)
            {
                char c = s[i];
                if (c == '\\' && i + 1 < s.Length)
                {
                    char n = s[i + 1];
                    switch (n)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        default: sb.Append(n); break;
                    }
                    i += 2;
                    continue;
                }
                if (c == '"') { i++; return sb.ToString(); }
                sb.Append(c);
                i++;
            }
            return null;
        }

        // —— 从表格写回 gateway.config.json ——
        // 保存供应商表格到 gateway.config.json（无 BOM）
        // notify=true 时给出界面/日志提示（按钮点击）；false 供启动/写 dsh 前自动落盘（静默）
        private void GwSaveToFile() { GwSaveToFile(true); }

        private void GwSaveToFile(bool notify)
        {
            try
            {
                int p; if (int.TryParse(txtGwPort.Text, out p) && p > 0 && p <= 65535) gwPort = p;
                gwKey = txtGwKey.Text.Trim();
                if (txtGwUA != null) gwClientUA = txtGwUA.Text.Trim();

                var provs = new List<Dictionary<string, object>>();
                foreach (DataGridViewRow row in gvProviders.Rows)
                {
                    if (row.IsNewRow) continue;
                    var pd = new Dictionary<string, object>();
                    pd["id"] = Convert.ToString(row.Cells[0].Value ?? "");
                    pd["baseURL"] = Convert.ToString(row.Cells[1].Value ?? "");
                    pd["apiKey"] = Convert.ToString(row.Cells[2].Value ?? "");
                    pd["models"] = (Convert.ToString(row.Cells[3].Value ?? "") ?? "").Split(new char[] { ',', '，' }, StringSplitOptions.RemoveEmptyEntries);
                    int prio = 1;
                    // TryParse 失败时保持默认 1（修复 L1：避免意外写成 0 的高优先级）
                    if (!int.TryParse(Convert.ToString(row.Cells[4].Value), out prio) || prio < 1) prio = 1;
                    pd["priority"] = prio;
                    string en = Convert.ToString(row.Cells[5].Value);
                    // 勾选列防异常：Checked 形态/空值都归一为布尔
                    bool enVal = false;
                    if (string.IsNullOrEmpty(en) && row.Cells[5] is DataGridViewCheckBoxCell)
                        enVal = SafeBool(((DataGridViewCheckBoxCell)row.Cells[5]).Value);
                    else
                        bool.TryParse(en, out enVal);
                    pd["enabled"] = enVal;
                    // 忽略空行（无 id 且无 url）
                    if (string.IsNullOrWhiteSpace(Convert.ToString(pd["id"])) && string.IsNullOrWhiteSpace(Convert.ToString(pd["baseURL"]))) continue;
                    provs.Add(pd);
                }

                if (!Directory.Exists(Path.GetDirectoryName(gwConfigPath))) Directory.CreateDirectory(Path.GetDirectoryName(gwConfigPath));
                File.WriteAllText(gwConfigPath, BuildGatewayJson(provs), Utf8NoBom);   // 无 BOM（N1）

                if (notify)
                {
                    lblGwHint.Text = "已保存 " + provs.Count + " 个供应商 → " + gwConfigPath;
                    AppendLog("[网关] 供应商配置已保存（" + provs.Count + " 家）。重启网关生效；可点「写入 dsh 配置」注册到 dsh。");
                }
                SaveSettings();
            }
            catch (Exception ex)
            {
                lblGwHint.Text = "保存失败：" + ex.Message;
                AppendLog("[错误] 保存网关配置失败: " + ex.Message);
            }
        }

        // 手写 gateway.config.json 序列化（转义 + 缩进；实例方法直接使用 gwPort/gwKey 字段）
        private string BuildGatewayJson(List<Dictionary<string, object>> provs)
        {
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine("  \"port\": " + gwPort + ",");
            sb.AppendLine("  \"apiKey\": \"" + JsonEsc(gwKey) + "\",");
            if (!string.IsNullOrEmpty(gwClientUA))
                sb.AppendLine("  \"clientUA\": \"" + JsonEsc(gwClientUA) + "\",");
            sb.AppendLine("  \"providers\": [");
            for (int i = 0; i < provs.Count; i++)
            {
                var p = provs[i];
                string comma = (i < provs.Count - 1) ? "," : "";
                sb.Append("    { \"id\": \"" + JsonEsc(Convert.ToString(p["id"])) + "\", \"baseURL\": \"" + JsonEsc(Convert.ToString(p["baseURL"])) + "\", \"apiKey\": \"" + JsonEsc(Convert.ToString(p["apiKey"])) + "\", \"priority\": " + Convert.ToString(p["priority"]) + ", \"enabled\": " + (SafeBool(p["enabled"]) ? "true" : "false") + ", \"models\": [");
                var models = (object[])p["models"];
                for (int j = 0; j < models.Length; j++)
                {
                    if (j > 0) sb.Append(", ");
                    sb.Append("\"" + JsonEsc(Convert.ToString(models[j])) + "\"");
                }
                sb.AppendLine("] }" + comma);
            }
            sb.AppendLine("  ]");
            sb.Append("}");
            return sb.ToString();
        }

        private static string JsonEsc(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        // 安全布尔转换（防 FormatException）
        private static bool SafeBool(object v)
        {
            if (v is bool) return (bool)v;
            string s = Convert.ToString(v);
            bool r;
            if (bool.TryParse(s, out r)) return r;
            return s == "1";
        }

        private void GwAddRow()
        {
            if (gvProviders == null) return;
            int idx = gvProviders.Rows.Add("provider-" + (gvProviders.Rows.Count + 1), "https://example.com/v1", "", "deepseek-v4-flash", 1, true);
            gvProviders.CurrentCell = gvProviders.Rows[idx].Cells[0];
            gvProviders.BeginEdit(true);
        }

        private void GwDeleteRow()
        {
            if (gvProviders == null || gvProviders.CurrentRow == null) return;
            int idx = gvProviders.CurrentRow.Index;
            if (idx >= 0 && idx < gvProviders.Rows.Count)
            {
                gvProviders.Rows.RemoveAt(idx);
                lblGwHint.Text = "已移除一行 —— 记得点「保存配置」生效。";
            }
        }

        private void EditGatewayConfig()
        {
            try
            {
                if (!File.Exists(gwConfigPath))
                {
                    string src = Path.Combine(GatewayDir(), "gateway.config.example.json");
                    if (!Directory.Exists(Path.GetDirectoryName(gwConfigPath))) Directory.CreateDirectory(Path.GetDirectoryName(gwConfigPath));
                    if (File.Exists(src)) File.Copy(src, gwConfigPath, true);
                    else { File.WriteAllText(gwConfigPath, "{\n  \"port\": 3090,\n  \"apiKey\": \"change-me\",\n  \"providers\": []\n}", Utf8NoBom); }
                    AppendLog("[网关] 已创建配置模板: " + gwConfigPath);
                }
                Process.Start("notepad.exe", "\"" + gwConfigPath + "\"");
                AppendLog("[网关] 已用记事本打开配置文件，保存后回到助手点「启动网关」。");
            }
            catch (Exception ex) { AppendLog("[错误] 打开网关配置失败: " + ex.Message); }
        }

        private void WriteGatewayToDsh()
        {
            try
            {
                // 先自动落盘表格中的供应商（修复 N2：用户编辑后直接点「写入 dsh 配置」会被丢弃）
                if (gvProviders != null && gvProviders.Rows.Count > 0) GwSaveToFile(false);

                int p; if (int.TryParse(txtGwPort.Text, out p) && p > 0 && p <= 65535) gwPort = p;
                gwKey = txtGwKey.Text.Trim();
                SaveSettings();

                if (!File.Exists(gwConfigPath)) { AppendLog("[网关] 网关配置不存在，请先「编辑供应商」保存后再执行。"); return; }
                // 统一 key 同步与校验（与 StartGateway 共用一套逻辑）
                if (!SyncGwKeyToConfig()) { return; }

                string dir = GatewayDir();
                string gwMjs = Path.Combine(dir, "model-gateway.mjs");
                if (!File.Exists(gwMjs)) { AppendLog("[错误] 找不到 model-gateway.mjs"); return; }

                string args = "\"" + gwMjs + "\" --write-dsh --config \"" + gwConfigPath + "\" --port " + gwPort;
                AppendLog("[网关→dsh] 正在写入 dsh 配置…");

                // 后台执行，避免阻塞 UI 线程（修复 G4：原同步 ReadToEnd+WaitForExit 最坏卡 15 秒）
                System.Threading.ThreadPool.QueueUserWorkItem(delegate(object st)
                {
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = "node.exe";
                        psi.Arguments = args;
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        psi.RedirectStandardOutput = true;
                        psi.RedirectStandardError = true;
                        psi.StandardOutputEncoding = Encoding.UTF8;
                        psi.StandardErrorEncoding = Encoding.UTF8;
                        string outp, err;
                        int exitCode;
                        using (Process proc = Process.Start(psi))
                        {
                            // 双流读取防死锁：先异步读完再等待
                            string so = "", se = "";
                            System.Threading.Tasks.Task<string> taskOut = proc.StandardOutput.ReadToEndAsync();
                            System.Threading.Tasks.Task<string> taskErr = proc.StandardError.ReadToEndAsync();
                            if (!proc.WaitForExit(30000)) { try { proc.Kill(); } catch { } }
                            exitCode = proc.HasExited ? proc.ExitCode : -1;
                            so = taskOut.Result; se = taskErr.Result;
                            outp = so; err = se;
                        }
                        int fc = exitCode;
                        OnUiThread(delegate
                        {
                            AppendLog("[网关→dsh] " + (outp + err).Trim().Replace("\n", " | "));
                            if (fc == 0)
                                AppendLog("[网关→dsh] 已完成：settings.yaml 已注册「gateway」提供商、credentials.yaml 已写入 DSH_GATEWAY_API_KEY。重启 dsh web 后即可在模型选择器里选用（需要网关保持运行）。");
                            else
                                AppendLog("[网关→dsh] 失败（退出码 " + fc + "），请确认 gateway.config.json 已填写 apiKey（非 change-me）与至少一个供应商。");
                        });
                    }
                    catch (Exception ex)
                    {
                        string msg = ex.Message;
                        OnUiThread(delegate { AppendLog("[错误] 写入 dsh 配置失败: " + msg); });
                    }
                });
            }
            catch (Exception ex) { AppendLog("[错误] 写入 dsh 配置失败: " + ex.Message); }
        }

        private void SetGwStatus(bool running)
        {
            try
            {
                gwRunningCached = running;   // 任何状态变更同步到缓存，供 UI 轮询读取
                gwCacheTime = DateTime.Now;
                if (lblGwStatus == null) return;
                lblGwStatus.Text = running ? "● 运行中" : "● 已停止";
                lblGwStatus.ForeColor = running ? Color.ForestGreen : Color.DimGray;
            }
            catch { }
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
                    else if (k == "gwPort") { int p; if (int.TryParse(v, out p) && p > 0 && p <= 65535) gwPort = p; }
                    else if (k == "gwKey") gwKey = v;
                    else if (k == "gwUA") gwClientUA = v;
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
                sb.AppendLine("gwPort=" + gwPort);
                sb.AppendLine("gwKey=" + gwKey);
                sb.AppendLine("gwUA=" + gwClientUA);
                File.WriteAllText(settingsFile, sb.ToString(), Utf8NoBom);   // 无 BOM（N1：ini 首行键名不能被 BOM 污染）

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

            // 用户主动退出（托盘"退出"/ForceExit）也要落盘；系统关闭（关机/注销/任务管理器）跳过避免拖慢关闭（修复 H1）
            if (forceExit && !systemClose)
            {
                try { ApplyUiSettings(); } catch { }
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

                // 退出时停止网关并释放进程句柄（修复 B2：避免孤儿进程占端口 + 句柄泄漏）
                try
                {
                    if (gwProc != null)
                    {
                        if (!gwProc.HasExited)
                        {
                            KillTreePrivate(gwProc.Id);
                            gwProc.WaitForExit(3000);
                        }
                        gwProc.Dispose();
                        gwProc = null;
                    }
                    // 兜底：遗留网关进程按端口清理（带身份校验）
                    int gwPid = FindListenerPid(gwPort);
                    if (gwPid > 0 && IsPlausibleDshName(GetProcessName(gwPid)))
                        KillTreePrivate(gwPid);
                    try { if (File.Exists(logPath)) File.AppendAllText(logPath, "[" + DateTime.Now.ToString("HH:mm:ss") + "] [信息] 助手退出，网关已停止。\r\n", Encoding.UTF8); } catch { }
                }
                catch { }
            }
            base.Dispose(disposing);
        }
    }
}
