// DSHDesktopSetup.cs — 自包含安装器 / 卸载器（单文件，纯 csc 编译，无外部依赖）
//
// 内嵌资源（编译时 /resource: 嵌入）：
//   DSHDesktop.exe                主程序
//   model-gateway.mjs             网关运行时
//   gateway.config.example.json   网关配置模板
//   README.md                     使用说明
//
// 用法：
//   DSHDesktopSetup.exe                     图形向导安装
//   DSHDesktopSetup.exe --silent [--dir C:\path]   静默安装（默认 %LOCALAPPDATA%\Programs\DSHDesktop）
//   DSHDesktopSetup.exe --uninstall         卸载（读取注册表中的安装位置）
//
// 安装动作：释放文件 → 创建桌面/开始菜单快捷方式 → 复制自身为 unins.exe → 写卸载注册表
// 卸载动作：删快捷方式 → 删注册表 → 删程序文件（保留 data/ 用户数据并提示）

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DSHSetup
{
    static class Program
    {
        const string APP_NAME = "DSH 桌面助手";
        const string REG_UNINST = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop";
        const string VERSION = "1.2.0";

        // 内嵌资源清单
        struct ResFile
        {
            public string ResName;   // 资源 manifest 名
            public string RelPath;   // 安装后的相对路径
            public ResFile(string r, string p) { ResName = r; RelPath = p; }
        };
        static readonly ResFile[] FILES = new ResFile[] {
            new ResFile("DSHDesktop.exe", "DSHDesktop.exe"),
            new ResFile("model-gateway.mjs", "gateway\\model-gateway.mjs"),
            new ResFile("gateway.config.example.json", "gateway\\gateway.config.example.json"),
            new ResFile("README.md", "README.md"),
        };

        // 默认安装目录：%LOCALAPPDATA%\Programs\DSHDesktop
        public static string DefaultInstallDir()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "DSHDesktop");
        }

        // 从注册表读取安装位置（卸载用）
        static string ReadInstalledDir()
        {
            try
            {
                using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(REG_UNINST))
                {
                    if (k != null)
                    {
                        object v = k.GetValue("InstallLocation");
                        if (v != null && !string.IsNullOrEmpty(Convert.ToString(v)) && Directory.Exists(Convert.ToString(v)))
                            return Convert.ToString(v);
                    }
                }
            }
            catch { }
            return null;
        }

        [STAThread]
        static int Main(string[] args)
        {
            bool silent = false, uninstall = false;
            string dir = null;
            foreach (string a in args)
            {
                string t = (a ?? "").Trim();
                if (t == "--uninstall") uninstall = true;
                else if (t == "--silent" || t == "/silent" || t == "/S") silent = true;
                else if (t.StartsWith("--dir=")) dir = t.Substring(6).Trim('"');
                else if (t.StartsWith("/dir=")) dir = t.Substring(5).Trim('"');
            }

            if (uninstall)
            {
                return DoUninstall(silent);
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (silent)
            {
                string target = string.IsNullOrEmpty(dir) ? DefaultInstallDir() : Path.GetFullPath(dir);
                return DoInstall(target, silent);
            }

            using (SetupForm f = new SetupForm(dir))
            {
                Application.Run(f);
                return f.ExitCode;
            }
        }

        // —— 实际安装（UI 线程调用；silent 时无窗体直接执行）——
        public static int DoInstall(string targetDir, bool silent)
        {
            try
            {
                Directory.CreateDirectory(targetDir);
                Directory.CreateDirectory(Path.Combine(targetDir, "gateway"));

                Assembly asm = Assembly.GetExecutingAssembly();
                foreach (ResFile rf in FILES)
                {
                    string outPath = Path.Combine(targetDir, rf.RelPath);
                    using (Stream s = asm.GetManifestResourceStream(rf.ResName))
                    {
                        if (s == null) throw new Exception("缺少内嵌资源: " + rf.ResName);
                        using (FileStream fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
                        {
                            s.CopyTo(fs);
                        }
                    }
                }

                string mainExe = Path.Combine(targetDir, "DSHDesktop.exe");

                // 复制自身为卸载器 unins.exe
                try { File.Copy(Application.ExecutablePath, Path.Combine(targetDir, "unins.exe"), true); } catch { }

                CreateShortcut(
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), APP_NAME + ".lnk"),
                    mainExe, targetDir);
                string startMenuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DSHDesktop");
                try
                {
                    if (!Directory.Exists(startMenuDir)) Directory.CreateDirectory(startMenuDir);
                    CreateShortcut(Path.Combine(startMenuDir, APP_NAME + ".lnk"), mainExe, targetDir);
                }
                catch { }

                // 卸载注册表
                using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(REG_UNINST))
                {
                    if (k != null)
                    {
                        k.SetValue("DisplayName", APP_NAME);
                        k.SetValue("DisplayVersion", VERSION);
                        k.SetValue("Publisher", "dsh-desktop");
                        k.SetValue("InstallLocation", targetDir);
                        k.SetValue("DisplayIcon", mainExe + ",0");
                        k.SetValue("UninstallString", "\"" + Path.Combine(targetDir, "unins.exe") + "\" --uninstall");
                        k.SetValue("QuietUninstallString", "\"" + Path.Combine(targetDir, "unins.exe") + "\" --uninstall --silent");
                        k.SetValue("EstimatedSize", 100);
                    }
                }

                if (silent)
                {
                    Console.WriteLine("installed: " + targetDir);
                    return 0;
                }
                return 0;
            }
            catch (Exception ex)
            {
                if (silent) { try { Console.WriteLine("install-failed: " + ex.Message); } catch { } }
                else MessageBox.Show("安装失败：" + ex.Message, APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        // —— 卸载 ——
        public static int DoUninstall(bool silent)
        {
            try
            {
                string dir = ReadInstalledDir();
                if (dir == null)
                {
                    if (!silent) MessageBox.Show("未找到 DSH 桌面助手的安装记录，可能已被手工删除。", APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    else Console.WriteLine("uninstall: no-record");
                    return 1;
                }

                // 删快捷方式
                try { File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), APP_NAME + ".lnk")); } catch { }
                try
                {
                    string sm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DSHDesktop");
                    if (Directory.Exists(sm)) Directory.Delete(sm, true);
                }
                catch { }

                // 删注册表
                try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(REG_UNINST, false); } catch { }

                // 删程序文件，但保留 data/（用户数据）——提示用户
                bool hadData = Directory.Exists(Path.Combine(dir, "data"));
                try
                {
                    foreach (string file in Directory.GetFiles(dir))
                    {
                        try { File.Delete(file); } catch { }
                    }
                    foreach (string sub in Directory.GetDirectories(dir))
                    {
                        if (Path.GetFileName(sub).ToLowerInvariant() != "data")
                        {
                            try { Directory.Delete(sub, true); } catch { }
                        }
                    }
                }
                catch { }

                if (!silent)
                {
                    MessageBox.Show(
                        "卸载完成。" + (hadData ? "\n\n检测到数据目录 data\\ 已保留（含设置/日志/网关配置），如需彻底删除请手动删除该目录。" : ""),
                        APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else Console.WriteLine(hadData ? "uninstall: done (data kept)" : "uninstall: done");
                return 0;
            }
            catch (Exception ex)
            {
                if (silent) { try { Console.WriteLine("uninstall-failed: " + ex.Message); } catch { } }
                else MessageBox.Show("卸载失败：" + ex.Message, APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        // —— 创建 .lnk（经 COM WScript.Shell，动态调用避免强依赖）——
        static void CreateShortcut(string lnkPath, string target, string workDir)
        {
            try
            {
                Type shType = Type.GetTypeFromProgID("WScript.Shell");
                if (shType == null) return;
                object shell = Activator.CreateInstance(shType);
                object sc = shType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                if (sc == null) return;
                Type scType = sc.GetType();
                scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
                scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
                scType.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { APP_NAME });
                scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
                scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
            }
            catch { /* 快捷方式失败不阻断安装 */ }
        }
    }

    // —— 图形安装向导（简版：目录选择 → 安装 → 完成）——
    class SetupForm : Form
    {
        public int ExitCode = 0;
        private TextBox txtDir;
        private Label lblInfo;
        private Button btnBrowse, btnInstall, btnCancel;
        private static string AppName { get { return "DSH 桌面助手"; } }

        public SetupForm(string presetDir)
        {
            Text = "安装 - " + AppName;
            ClientSize = new Size(560, 320);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9F);

            Label title = new Label();
            title.Text = "DSH 桌面助手 v1.2.0";
            title.Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold);
            title.SetBounds(24, 20, 520, 30);

            Label desc = new Label();
            desc.Text = "一键启动/停止/自动更新 DeepSeek Harness 的 dsh web 服务，\n内置多供应商模型网关。安装到任意目录，数据随程序目录存放（绿色便携）。";
            desc.SetBounds(24, 56, 520, 44);

            Label l1 = new Label(); l1.Text = "安装目录:"; l1.SetBounds(24, 120, 70, 24);
            txtDir = new TextBox();
            txtDir.Text = string.IsNullOrEmpty(presetDir) ? Program.DefaultInstallDir() : presetDir;
            txtDir.SetBounds(96, 118, 360, 24);
            btnBrowse = new Button(); btnBrowse.Text = "浏览…"; btnBrowse.SetBounds(462, 117, 74, 26);
            btnBrowse.Click += delegate
            {
                FolderBrowserDialog d = new FolderBrowserDialog();
                d.Description = "选择安装目录";
                d.SelectedPath = txtDir.Text;
                if (d.ShowDialog(this) == DialogResult.OK) txtDir.Text = d.SelectedPath;
            };

            lblInfo = new Label();
            lblInfo.Text = "将安装 4 个文件，并创建桌面与开始菜单快捷方式。";
            lblInfo.ForeColor = Color.FromArgb(100, 100, 100);
            lblInfo.SetBounds(24, 152, 520, 24);

            btnInstall = new Button();
            btnInstall.Text = "安装";
            btnInstall.BackColor = Color.FromArgb(0, 120, 212);
            btnInstall.ForeColor = Color.White;
            btnInstall.FlatStyle = FlatStyle.Flat;
            btnInstall.SetBounds(316, 260, 100, 34);
            btnInstall.Click += delegate
            {
                btnInstall.Enabled = false;
                int code = Program.DoInstall(txtDir.Text.Trim(), false);
                if (code == 0)
                {
                    DialogResult r = MessageBox.Show("安装完成！\n是否立即启动 DSH 桌面助手？", "DSH 桌面助手",
                        MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                    if (r == DialogResult.Yes)
                    {
                        try { Process.Start(Path.Combine(txtDir.Text.Trim(), "DSHDesktop.exe")); } catch { }
                    }
                    ExitCode = 0;
                    Close();
                }
                else
                {
                    btnInstall.Enabled = true;
                }
            };

            btnCancel = new Button();
            btnCancel.Text = "取消";
            btnCancel.FlatStyle = FlatStyle.Flat;
            btnCancel.SetBounds(424, 260, 90, 34);
            btnCancel.Click += delegate { ExitCode = 2; Close(); };

            Controls.AddRange(new Control[] { title, desc, l1, txtDir, btnBrowse, lblInfo, btnInstall, btnCancel });
        }
    }
}