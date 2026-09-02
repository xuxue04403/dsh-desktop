# Build the portable release zip (exe + gateway runtime + readme).
# Usage: powershell -File _build-portable.ps1 [-OutputDir <dir>]
# NOTE: keep this file pure ASCII so it parses under Windows PowerShell 5.1
# regardless of code page. Chinese text lives in the separate readme file.
param(
    [string]$OutputDir = (Join-Path $PSScriptRoot 'dist'),
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# 1) ensure latest exe（不加管道：沙箱/PS5.1 下管道包裹会触发 csc 输出捕获限制）
if (-not $SkipBuild) {
    & (Join-Path $root 'build.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host '[错误] build.ps1 编译失败' -ForegroundColor Red; exit 1 }
}
if (-not (Test-Path (Join-Path $root 'DSHDesktop.exe'))) {
    Write-Host '[错误] 缺少 DSHDesktop.exe，请先运行 build.ps1' -ForegroundColor Red
    exit 1
}

# 2) assemble portable folder
$staging = Join-Path $env:TEMP "dsh-desktop-portable-$(Get-Random)"
New-Item $staging -ItemType Directory -Force | Out-Null
$name = 'DSHDesktop'
$dir = Join-Path $staging $name
New-Item $dir -ItemType Directory -Force | Out-Null

Copy-Item (Join-Path $root 'DSHDesktop.exe') $dir -Force

# gateway: runtime files only (no tests)
New-Item (Join-Path $dir 'gateway') -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $root 'gateway\model-gateway.mjs') (Join-Path $dir 'gateway') -Force
Copy-Item (Join-Path $root 'gateway\gateway.config.example.json') (Join-Path $dir 'gateway') -Force

# readme for the portable bundle (UTF-8 BOM file, kept in repo).
# ASCII file name on purpose: PS 5.1 Compress-Archive writes non-UTF8
# entry names, which garbles Chinese file names inside the zip.
Copy-Item (Join-Path $root 'portable-readme.txt') (Join-Path $dir 'README-portable.txt') -Force

# 3) zip
if (-not (Test-Path $OutputDir)) { New-Item $OutputDir -ItemType Directory -Force | Out-Null }
$zip = Join-Path $OutputDir 'DSHDesktop-portable.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging "$name\*") -DestinationPath $zip -CompressionLevel Optimal

# 4) cleanup
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[OK] portable bundle: $zip"
$zip