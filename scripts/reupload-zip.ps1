# 单独重传 v1.5.5 的绿色版 zip 资产
param(
    [Parameter(Mandatory = $true)]
    [string]$Token,
    [string]$RepoName = 'dsh-desktop',
    [string]$Version = 'v1.5.5'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$headers = @{
    'Authorization'        = "Bearer $Token"
    'Accept'               = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'dsh-app-publisher'
}

# 读取 version 并确认 zip 存在
$ver = $Version.Substring(1)
$zipPath = Join-Path $root ("dist\DSHApp-" + $ver + "-Portable.zip")
if (-not (Test-Path $zipPath)) {
    Write-Host '[FAIL] zip not found: ' $zipPath
    exit 1
}
Write-Host ("[..] zip: {0} ({1:N1} MB)" -f $zipPath, ((Get-Item $zipPath).Length / 1MB))

# 找到 release
$login = 'xuxue04403'
$repoUri = "https://api.github.com/repos/$login/$RepoName"
try { $rel = Invoke-RestMethod -Method GET -Uri "$repoUri/releases/tags/$Version" -Headers $headers } catch {
    Write-Host ('[FAIL] release not found: {0}' -f $_.Exception.Message)
    exit 1
}
Write-Host ("[..] release id: {0}" -f $rel.id)

$name = "DSHApp-Portable-" + $ver + ".zip"
$up = "https://uploads.github.com/repos/$login/$RepoName/releases/$($rel.id)/assets?name=$name"
try {
    Invoke-RestMethod -Method Post -Uri $up -Headers $headers -ContentType 'application/zip' -InFile $zipPath | Out-Null
    Write-Host "[OK] asset: $name" -ForegroundColor Green
} catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 422) {
        Write-Host '[..] replacing existing asset...'
        $existing = Invoke-RestMethod -Method GET -Uri "$repoUri/releases/$($rel.id)/assets" -Headers $headers
        foreach ($a in $existing) { if ($a.name -eq $name) { Invoke-RestMethod -Method Delete -Uri $a.url -Headers $headers | Out-Null } }
        Invoke-RestMethod -Method Post -Uri $up -Headers $headers -ContentType 'application/zip' -InFile $zipPath | Out-Null
        Write-Host "[OK] asset replaced: $name" -ForegroundColor Green
    } else {
        Write-Host ("[WARN] asset failed $name (HTTP $status): " + $_.Exception.Message) -ForegroundColor Yellow
        exit 1
    }
}
Write-Host ('[OK] done: https://github.com/' + $login + '/' + $RepoName + '/releases/tag/' + $Version)