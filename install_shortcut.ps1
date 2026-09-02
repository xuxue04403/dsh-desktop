# 在桌面创建「DSH 桌面助手」快捷方式（可选）
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'DSHDesktop.exe'
if (-not (Test-Path $exe)) { Write-Host "[错误] 未找到 $exe，请先运行 build.ps1 编译。" -ForegroundColor Red; exit 1 }

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'DSH 桌面助手.lnk'
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = $exe
$s.WorkingDirectory = $PSScriptRoot
$s.IconLocation = "$exe,0"
$s.Description = 'DSH 桌面助手 - 一键启动 dsh 服务'
$s.Save()

Write-Host "已在桌面创建快捷方式: $lnk" -ForegroundColor Green
Write-Host "双击即可开始使用！"
