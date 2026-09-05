<#
.SYNOPSIS
  Build and publish DSH App to github.com/xuxue04403/dsh-desktop
  (source upload + installer/portable release assets). No git client required.

.USAGE
  powershell -ExecutionPolicy Bypass -File .\scripts\release.ps1 -Token <YOUR_TOKEN>
  powershell -ExecutionPolicy Bypass -File .\scripts\release.ps1 -Token <TOKEN> -CleanOld

.PARAMETER Token
  GitHub token. Classic token scope: repo. Fine-grained: Contents(RW), Metadata(R), Workflows(RW).

.PARAMETER RepoName
  Repository name (default dsh-desktop).

.PARAMETER Version
  Override release version tag. Default: v<package.json version>.

.PARAMETER CleanOld
  Remove v1.x C# launcher leftovers from the repo before uploading.
.NOTES
  - Version is read from package.json unless -Version is given, so bumping the
    app version only requires editing package.json.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Token,
    [string]$RepoName = 'dsh-desktop',
    [string]$Version = '',
    [switch]$CleanOld
)

$ErrorActionPreference = 'Stop'
# 脚本位于项目根/scripts/ 下：$PSScriptRoot = scripts/，项目根 = 其父目录
$root = Split-Path -Parent $PSScriptRoot

# 版本：默认从 package.json 读取（如 1.5.5 → v1.5.5）
if (-not $Version) {
    # 显式 UTF-8 读取（package.json 无 BOM，PS5.1 默认 GBK 会乱码导致 JSON 失败）
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = 'v' + $pkg.version
}
Write-Host "[..] Release version: $Version"

$headers = @{
    'Authorization'        = "Bearer $Token"
    'Accept'               = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'dsh-app-publisher'
}

function Api([string]$Method, [string]$Uri, $BodyObj) {
    $json = if ($null -ne $BodyObj) { $BodyObj | ConvertTo-Json -Depth 8 } else { $null }
    Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -ContentType 'application/json' -Body $json
}

# ---------- 0. build chain ----------
Write-Host '[..] 1/4 portable dir (green edition)...'
$buildOut = (& node (Join-Path $root 'scripts\build-portable.mjs') 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { Write-Host '[FAIL] build-portable.mjs'; Write-Host $buildOut; exit 1 }
$outDirLine = ($buildOut -split "`r?`n") | Where-Object { $_ -like 'OUTDIR=*' } | Select-Object -First 1
$greenDir = if ($outDirLine) { $outDirLine.Substring(7).Trim() } else { Join-Path $root 'out\DSH-App' }
Write-Host "[..] green dir: $greenDir"

Write-Host '[..] 2/4 icon policy: keep Electron official icon for exe/installer...'
# 图标策略（与产品一致）：exe / 安装版 / 单文件便携版全部沿用 Electron 官方深蓝原子图标
# （绿色版 exe 即 electron 原样；electron-builder 未配置 win.icon 时使用官方默认图标）。
# 托盘/窗口图标由运行时以同风格绘制（底色随服务状态变色），不再使用 rcedit 改写 exe 资源。

Write-Host '[..] 3/4 NSIS installer + single-file portable (mirror)...'
node (Join-Path $root 'scripts\dist.mirror.mjs')
if ($LASTEXITCODE -ne 0) { Write-Host '[FAIL] dist.mirror.mjs (NSIS build)'; exit 1 }

# portable zip for release asset（从 build 输出的实际绿色目录打包；文件名用 ASCII，避免 PS5.1 编码问题）
$zipOut = Join-Path $root 'dist'
$zipPath = Join-Path $zipOut ("DSHApp-" + $Version.Substring(1) + "-Portable.zip")
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (-not (Test-Path (Join-Path $greenDir 'DSH-App.exe'))) {
    Write-Host "[FAIL] green dir missing exe: $greenDir"
    exit 1
}
Compress-Archive -Path (Join-Path $greenDir '*') -DestinationPath $zipPath -CompressionLevel Optimal

# ---------- 1. verify identity ----------
Write-Host '[..] 4/4 publish...'
try { $me = Api 'GET' 'https://api.github.com/user' } catch {
    Write-Host '[FAIL] Token invalid or network unreachable:' $_.Exception.Message
    exit 1
}
$login = $me.login
if ($login -ne 'xuxue04403') { Write-Host "[WARN] authenticated as $login (expect xuxue04403)" -ForegroundColor Yellow }
Write-Host "[OK] Authenticated as: $login" -ForegroundColor Green

$repoUri = "https://api.github.com/repos/$login/$RepoName"
try { Api 'GET' $repoUri | Out-Null } catch {
    Write-Host "[FAIL] repo not found: $repoUri"
    exit 1
}

# ---------- 2. optional: remove v1.x C# launcher leftovers ----------
if ($CleanOld) {
    Write-Host '[..] -CleanOld: removing v1.x C# launcher files...'
    $old = @(
        'DSHDesktop.cs', 'build.ps1', 'build_icon.ps1', 'install_shortcut.ps1',
        'run-all-tests.ps1', '_build-portable.ps1', 'portable-readme.txt',
        'publish-to-github.ps1', 'DSHDesktopSetup.cs',
        'setup', 'gateway', 'dist', '.github\workflows\build.yml'
    )
    foreach ($rel0 in $old) {
        $rel = $rel0.Replace('\', '/')
        try {
            $info = Api 'GET' "$repoUri/contents/$rel"
            if ($info) {
                if ($info -is [array]) {
                    foreach ($item in $info) {
                        Api 'DELETE' "$repoUri/contents/$($item.path)" @{ message = "chore: remove v1.x $($item.path)"; sha = $item.sha } | Out-Null
                        Write-Host "  del $($item.path)"
                    }
                } else {
                    Api 'DELETE' "$repoUri/contents/$rel" @{ message = "chore: remove v1.x $rel"; sha = $info.sha } | Out-Null
                    Write-Host "  del $rel"
                }
            }
        } catch { Write-Host "  skip $rel (not present or no permission)" -ForegroundColor DarkGray }
    }
}

# ---------- 3. upload source files ----------
Write-Host '[..] Uploading sources...'
$count = 0
Get-ChildItem $root -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    if ($rel -like 'node_modules/*') { return }
    if ($rel -like 'out/*') { return }
    if ($rel -like 'dist/*') { return }
    if ($rel -like '.git/*') { return }
    if ($rel -like 'tests/*.tmp*') { return }

    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName))
    $uri = "https://api.github.com/repos/$login/$RepoName/contents/$rel"
    $sha = $null
    try { $sha = (Api 'GET' $uri).sha } catch { }

    $msg = if ($sha) { "chore: update $rel" } else { "feat: add $rel" }
    try {
        Api 'PUT' $uri @{ message = $msg; content = $b64; sha = $sha } | Out-Null
        Write-Host "  up $rel"
        $count++
    } catch {
        Write-Host "  !! $rel failed" -ForegroundColor Yellow
    }
}
Write-Host "[OK] Uploaded $count file(s)." -ForegroundColor Green

# ---------- 4. release + assets ----------
$ver = $Version.Substring(1)   # 去掉 v 前缀
$assets = @{}
$setupExe = Join-Path $root ("dist\DSHApp-" + $ver + "-x64.exe")
if (Test-Path $setupExe) { $assets["DSHApp-Setup-" + $ver + "-x64.exe"] = $setupExe } else { Write-Host '[WARN] NSIS setup missing' -ForegroundColor Yellow }

$portableExe = Get-ChildItem (Join-Path $root 'dist') -Filter ("DSHApp-" + $ver + "-便携版.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portableExe) { $assets["DSHApp-Portable-" + $ver + "-x64.exe"] = $portableExe.FullName } else { Write-Host '[WARN] portable exe missing' -ForegroundColor Yellow }

if (Test-Path $zipPath) { $assets["DSHApp-Portable-" + $ver + ".zip"] = $zipPath }

if ($assets.Count -gt 0) {
    $rel = $null
    try { $rel = Api 'GET' "$repoUri/releases/tags/$Version" } catch { }
    if (-not $rel) {
        $bodyText = "DSH App $Version (Electron desktop shell for DeepSeek Harness)" + [Environment]::NewLine + [Environment]::NewLine +
            "What's new in ${Version}:" + [Environment]::NewLine +
            "- Embedded Harness UI (WebView2-free Electron shell, loopback + token contract)" + [Environment]::NewLine +
            "- Safe mode: plugin crash auto-quarantine (patch disable + fallback minimal profile)" + [Environment]::NewLine +
            "- Model gateway: visual provider config, priority routing, failover, SSE, anthropic protocol" + [Environment]::NewLine +
            "- Input history (up/down keys), float settings entry, official Electron icon consistency" + [Environment]::NewLine +
            "- Portable data dir (exe-adjacent data\), auto one-time gateway config migration from DSH Desktop" + [Environment]::NewLine +
            "- Zero native deps: no VS toolchain required" + [Environment]::NewLine + [Environment]::NewLine +
            "Assets:" + [Environment]::NewLine +
            "- DSHApp-Setup-" + $ver + "-x64.exe : NSIS installer (recommended)" + [Environment]::NewLine +
            "- DSHApp-Portable-" + $ver + "-x64.exe : single-file portable" + [Environment]::NewLine +
            "- DSHApp-Portable-" + $ver + ".zip : green edition folder"
        $rel = Api 'POST' "$repoUri/releases" @{
            tag_name   = $Version
            name       = $Version
            body       = $bodyText
            draft      = $false
            prerelease = $false
        }
        Write-Host "[OK] Release $Version created."
    } else {
        Write-Host "[INFO] Release $Version exists; attaching assets."
    }

    foreach ($name in $assets.Keys) {
        $file = $assets[$name]
        $ct = if ($name -like '*.zip') { 'application/zip' } else { 'application/octet-stream' }
        $up = "https://uploads.github.com/repos/$login/$RepoName/releases/$($rel.id)/assets?name=$name"
        try {
            Invoke-RestMethod -Method Post -Uri $up -Headers $headers -ContentType $ct -InFile $file | Out-Null
            Write-Host "[OK] asset: $name" -ForegroundColor Green
        } catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($status -eq 422) {
                Write-Host "[..] replacing existing asset $name ..."
                $existing = Api 'GET' "$repoUri/releases/$($rel.id)/assets"
                foreach ($a in $existing) { if ($a.name -eq $name) { Invoke-RestMethod -Method Delete -Uri $a.url -Headers $headers | Out-Null } }
                Invoke-RestMethod -Method Post -Uri $up -Headers $headers -ContentType $ct -InFile $file | Out-Null
                Write-Host "[OK] asset replaced: $name" -ForegroundColor Green
            } else {
                Write-Host ("[WARN] asset failed $name (HTTP $status)") -ForegroundColor Yellow
            }
        }
    }
} else {
    Write-Host '[SKIP] no release assets produced.'
}

Write-Host ''
Write-Host ("DONE! https://github.com/" + $login + "/" + $RepoName + "/releases/tag/" + $Version) -ForegroundColor Green
Write-Host 'SECURITY: revoke the token now.'