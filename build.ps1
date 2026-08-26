# 编译 DSHDesktop.exe —— 使用 Windows 自带 .NET Framework 的 C# 编译器，无需安装任何 SDK
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# 定位系统自带 C# 编译器
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { Write-Host '[错误] 未找到系统 C# 编译器 csc.exe' -ForegroundColor Red; exit 1 }

# 生成图标（如不存在）
if (-not (Test-Path (Join-Path $root 'app.ico'))) {
    & (Join-Path $root 'build_icon.ps1')
}

Write-Host "正在使用 $csc 编译…"

$args = @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    "/out:$root\DSHDesktop.exe",
    "/win32icon:$root\app.ico",
    "$root\DSHDesktop.cs"
)

# 若旧 exe 被占用（助手正在托盘运行），自动改名腾位；Windows 允许重命名运行中的 exe
$exePath = Join-Path $root 'DSHDesktop.exe'
if (Test-Path $exePath) {
    try {
        Remove-Item $exePath -Force -ErrorAction Stop
    } catch {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupName = "DSHDesktop.old-$stamp.exe"
        Rename-Item $exePath $backupName -Force
        Write-Host "[提示] 旧版正被运行中的助手占用，已改名为 $backupName；新版本编译为 DSHDesktop.exe，重启助手后生效。" -ForegroundColor Yellow
    }
}

& $csc @args
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 编译失败 (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

Write-Host "编译成功 ✅"
Write-Host "可执行文件: $root\DSHDesktop.exe"
Write-Host "双击即可运行（Windows 自带 .NET Framework 4.x，无需额外安装）。"
