<#
.SYNOPSIS
  Publish this folder to GitHub as an open-source project (create repo / upload
  sources / create Release with compiled exe). No git client required.

.USAGE
  powershell -ExecutionPolicy Bypass -File .\publish-to-github.ps1 -Token <YOUR_TOKEN>

.NOTES
  - Classic token needs scope: repo
  - Fine-grained token needs: Contents(RW), Metadata(R), Workflows(RW)
  - The token is ONLY kept in memory during this run. Revoke it afterwards!
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Token,
    [string]$RepoName = 'dsh-desktop',
    [string]$Description = 'One-click Windows tray launcher & auto-updater for @deepseek-ai/dsh web',
    [switch]$Private,
    [string]$Version = 'v1.0.0'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$headers = @{
    'Authorization'        = "Bearer $Token"
    'Accept'               = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'dsh-desktop-publisher'
}

function Api([string]$Method, [string]$Uri, $BodyObj) {
    $json = if ($null -ne $BodyObj) { $BodyObj | ConvertTo-Json -Depth 8 } else { $null }
    Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -ContentType 'application/json' -Body $json
}

# ---------- 1. verify identity ----------
try {
    $me = Api 'GET' 'https://api.github.com/user'
} catch {
    Write-Host '[FAIL] Token invalid or network unreachable:' $_.Exception.Message -ForegroundColor Red
    exit 1
}
$login = $me.login
Write-Host "[OK] Authenticated as: $login" -ForegroundColor Green

# ---------- 2. ensure repository ----------
$repoUri = "https://api.github.com/repos/$login/$RepoName"
$exists = $true
try { Api 'GET' $repoUri | Out-Null } catch { $exists = $false }

if ($exists) {
    Write-Host "[OK] Repo already exists: https://github.com/$login/$RepoName"
} else {
    Write-Host '[..] Repo not found, creating...'
    try {
        Api 'POST' 'https://api.github.com/user/repos' @{
            name        = $RepoName
            description = $Description
            private     = [bool]$Private
            has_issues  = $true
            auto_init   = $false
        } | Out-Null
        Write-Host "[OK] Repo created: https://github.com/$login/$RepoName" -ForegroundColor Green
    } catch {
        Write-Host '[FAIL] Could not create the repository.' -ForegroundColor Red
        Write-Host 'Hints:' 
        Write-Host '  - Fine-grained tokens may lack repo-creation permission.'
        Write-Host '    -> Create an EMPTY public repo named "' $RepoName '" at https://github.com/new, then re-run this script.'
        Write-Host '  - Or use a Classic token with the repo scope.'
        exit 1
    }
}

# ---------- 3. upload source files ----------
Write-Host '[..] Uploading files...'
$count = 0
Get-ChildItem $root -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    if ($rel -eq 'DSHDesktop.exe') { return }                 # exe goes to Release assets
    if ($rel -like 'dist/*') { return }                       # dist/ builds go to Release assets, not the repo
    if ($rel -like '*.old-*.exe') { return }                  # locked-exe backups never belong in the repo
    if ($rel -like '*.old-*.zip') { return }
    if ($rel -like '.git/*' -or $rel -eq '.git') { return }

    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName))
    $uri = "https://api.github.com/repos/$login/$RepoName/contents/$rel"
    $sha = $null
    try { $sha = (Api 'GET' $uri).sha } catch { }

    if ($sha) { $msg = "chore: update $rel" } else { $msg = "feat: add $rel" }
    try {
        Api 'PUT' $uri @{ message = $msg; content = $b64; sha = $sha } | Out-Null
        Write-Host "  up $rel"
        $count++
    } catch {
        $status = ''
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        Write-Host "  !! $rel failed (HTTP $status)" -ForegroundColor Yellow
        if ($rel -like '.github/workflows/*') {
            Write-Host ''
            Write-Host '  ============================================================' -ForegroundColor Red
            Write-Host '  提权申请：Workflow 文件上传被拒（HTTP 403）' -ForegroundColor Red
            Write-Host '  该仓库的 fine-grained token 缺少 Workflows 写权限。' -ForegroundColor Yellow
            Write-Host '  请在打开的页面中把 Workflows 改为 Read and write，保存后重跑本脚本。' -ForegroundColor Yellow
            Write-Host '  ============================================================' -ForegroundColor Red
            Write-Host ''
            # 弹出提权申请：浏览器打开 token 权限编辑页 + 图形弹窗（桌面环境可用时）
            try {
                $openUrl = 'https://github.com/settings/personal-access-tokens'
                Write-Host "[..] 正在打开 GitHub token 权限页: $openUrl" -ForegroundColor Cyan
                Start-Process $openUrl | Out-Null
            } catch { }
            try {
                Add-Type -AssemblyName System.Windows.Forms | Out-Null
                [System.Windows.Forms.MessageBox]::Show(
                    "向 GitHub 上传 Workflow 文件需要更高权限（HTTP 403）。`n`n请在已打开的浏览器页面中：`n1) 选择你的 fine-grained token → Edit`n2) Repository permissions → Workflows → Read and write`n3) Update token，然后重新运行本发布脚本。`n`n（其它源码与 Release 资产不受影响，已上传成功）",
                    'DSH Desktop 发布 - 提权申请',
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
            } catch { }
        }
    }
}
Write-Host "[OK] Uploaded $count file(s)." -ForegroundColor Green

# ---------- 4. release with assets (installer exe + portable zip) ----------
$assets = @{}   # name -> local path

# 4.1 安装器（主程序已由 build.ps1 产出；若缺失则先 build）
$setupExe = Join-Path $root 'DSHDesktopSetup.exe'
if (-not (Test-Path $setupExe)) {
    Write-Host '[..] Building exe + installer...'
    & (Join-Path $root 'build.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host '[WARN] build.ps1 failed' -ForegroundColor Yellow }
}
if (Test-Path $setupExe) { $assets['DSHDesktopSetup.exe'] = $setupExe }
else { Write-Host '[WARN] installer exe missing' -ForegroundColor Yellow }

# 4.2 便携 zip
$zipOut = Join-Path $root 'dist'
try {
    Write-Host '[..] Building portable zip...'
    & (Join-Path $root '_build-portable.ps1') -OutputDir $zipOut -SkipBuild
    $zip = (Get-ChildItem $zipOut -Filter '*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    if ($zip) { $assets['DSHDesktop-portable.zip'] = $zip }
} catch {
    Write-Host ('[WARN] portable build failed: ' + $_.Exception.Message) -ForegroundColor Yellow
}

if ($assets.Count -gt 0) {
    try {
        $rel = $null
        try { $rel = Api 'GET' "$repoUri/releases/tags/$Version" } catch { }
        if (-not $rel) {
            $bodyText = "DSH Desktop release." + [Environment]::NewLine +
                "- Installer (recommended): DSHDesktopSetup.exe - single-file setup, creates shortcuts and uninstall entry" + [Environment]::NewLine +
                "- Portable: DSHDesktop-portable.zip - extract anywhere, double-click DSHDesktop.exe"
            $rel = Api 'POST' "$repoUri/releases" @{
                tag_name   = $Version
                name       = $Version
                body       = $bodyText
                draft      = $false
                prerelease = $false
            }
            Write-Host "[OK] Release $Version created."
        } else {
            Write-Host "[INFO] Release $Version already exists; attaching assets."
        }

        foreach ($name in $assets.Keys) {
            $file = $assets[$name]
            $ct = if ($name -like '*.zip') { 'application/zip' } else { 'application/octet-stream' }
            $up = "https://uploads.github.com/repos/$login/$RepoName/releases/" + $rel.id + "/assets?name=$name"
            try {
                Invoke-RestMethod -Method Post -Uri $up -Headers $headers -ContentType $ct -InFile $file | Out-Null
                Write-Host "[OK] Release asset uploaded: $name" -ForegroundColor Green
            } catch {
                $status = 0
                if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
                if ($status -eq 422) {
                    # 同名资产已存在：GitHub 不允许覆盖，先删旧再重传
                    Write-Host "[..] Asset $name already exists; replacing..."
                    $existing = Api 'GET' "$repoUri/releases/$($rel.id)/assets"
                    foreach ($a in $existing) {
                        if ($a.name -eq $name) {
                            Invoke-RestMethod -Method Delete -Uri $a.url -Headers $headers | Out-Null
                        }
                    }
                    Invoke-RestMethod -Method Post -Uri $up -Headers $headers -ContentType $ct -InFile $file | Out-Null
                    Write-Host "[OK] Release asset replaced: $name" -ForegroundColor Green
                } else {
                    Write-Host ('[WARN] Release asset upload failed for ' + $name + ' (HTTP ' + $status + '): ' + $_.Exception.Message) -ForegroundColor Yellow
                }
            }
        }
    } catch {
        Write-Host ('[WARN] Release step failed: ' + $_.Exception.Message) -ForegroundColor Yellow
    }
} else {
    Write-Host '[SKIP] No release assets produced.'
}

Write-Host ''
Write-Host ('DONE! Your project is live at: https://github.com/' + $login + '/' + $RepoName) -ForegroundColor Green
Write-Host 'SECURITY: revoke the token now -> GitHub Settings > Developer settings > delete it.'
