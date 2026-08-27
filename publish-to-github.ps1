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
            Write-Host '     -> Workflow files need extra permission.' -ForegroundColor Yellow
            Write-Host '     -> Edit your fine-grained token: set Workflows = Read and write, then re-run.' -ForegroundColor Yellow
        }
    }
}
Write-Host "[OK] Uploaded $count file(s)." -ForegroundColor Green

# ---------- 4. release with compiled exe ----------
$exe = Join-Path $root 'DSHDesktop.exe'
if (Test-Path $exe) {
    try {
        $rel = $null
        try { $rel = Api 'GET' "$repoUri/releases/tags/$Version" } catch { }
        if (-not $rel) {
            $bodyText = "First open-source release." + [Environment]::NewLine + "- One-click start/stop/auto-update tray tool for dsh web."
            $rel = Api 'POST' "$repoUri/releases" @{
                tag_name   = $Version
                name       = $Version
                body       = $bodyText
                draft      = $false
                prerelease = $false
            }
            Write-Host "[OK] Release $Version created."
        } else {
            Write-Host "[INFO] Release $Version already exists; attaching asset."
        }

        $up = "https://uploads.github.com/repos/$login/$RepoName/releases/" + $rel.id + "/assets?name=DSHDesktop.exe"
        try {
            Invoke-RestMethod -Method Post -Uri $up -Headers $headers -ContentType 'application/octet-stream' -InFile $exe | Out-Null
            Write-Host '[OK] Release asset uploaded: DSHDesktop.exe' -ForegroundColor Green
        } catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($status -eq 422) {
                # same-name asset exists: GitHub forbids overwrite, so delete old asset first
                Write-Host '[..] Asset name already exists on this release; replacing...' -ForegroundColor Yellow
                $assets = Api 'GET' "$repoUri/releases/$($rel.id)/assets"
                foreach ($a in $assets) {
                    if ($a.name -eq 'DSHDesktop.exe') {
                        Invoke-RestMethod -Method Delete -Uri $a.url -Headers $headers | Out-Null
                        Write-Host '[OK] Old asset deleted.'
                    }
                }
                Invoke-RestMethod -Method Post -Uri $up -Headers $headers -ContentType 'application/octet-stream' -InFile $exe | Out-Null
                Write-Host '[OK] Release asset replaced: DSHDesktop.exe' -ForegroundColor Green
            } else {
                Write-Host ('[WARN] Release asset upload failed (HTTP ' + $status + '): ' + $_.Exception.Message) -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Host ('[WARN] Release step failed: ' + $_.Exception.Message) -ForegroundColor Yellow
    }
} else {
    Write-Host '[SKIP] DSHDesktop.exe not found next to script; build first if you want a Release asset.'
}

Write-Host ''
Write-Host ('DONE! Your project is live at: https://github.com/' + $login + '/' + $RepoName) -ForegroundColor Green
Write-Host 'SECURITY: revoke the token now -> GitHub Settings > Developer settings > delete it.'
