# Gateway E2E (PowerShell version — harness sandbox allows Start-Process children to
# reach localhost, while Node-spawned children inherit the sandbox network isolation).
$ErrorActionPreference = 'Stop'
$gatewayDir = 'D:\IDE\dsh\dsh-desktop\gateway'
$tmp = Join-Path $env:TEMP "gw-e2e-$(Get-Random)"
New-Item $tmp -ItemType Directory -Force | Out-Null
$config = @"
{"port":3199,"apiKey":"test-key-123","providers":[
 {"id":"A","baseURL":"http://127.0.0.1:3190/v1","apiKey":"k-a","models":["deepseek-v4-flash"],"priority":1,"enabled":true},
 {"id":"B","baseURL":"http://127.0.0.1:3191/v1","apiKey":"k-b","models":["deepseek-v4-flash"],"priority":2,"enabled":true},
 {"id":"C","baseURL":"http://127.0.0.1:3192/v1","apiKey":"k-c","models":["glm-5.2"],"priority":3,"enabled":true}
]}
"@
Set-Content -Path (Join-Path $tmp 'gateway.config.json') -Value $config -Encoding ascii
$env:DSH_GATEWAY_CONFIG = Join-Path $tmp 'gateway.config.json'
$env:DSH_GATEWAY_LOG = Join-Path $tmp 'gateway.log'
$env:MOCK_PORT = '3190'

$mock = Start-Process node -ArgumentList (Join-Path $gatewayDir '_mock-upstreams.mjs') -WindowStyle Hidden -PassThru
$gw   = Start-Process node -ArgumentList (Join-Path $gatewayDir 'model-gateway.mjs') -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

$passed = 0; $failed = 0
function Check($name, $cond, $extra = '') {
  if ($cond) { $script:passed++; Write-Host "  PASS  $name" -ForegroundColor Green }
  else { $script:failed++; Write-Host "  FAIL  $name  $extra" -ForegroundColor Red }
}
function Call($path, $method, $body = $null, $key = 'test-key-123') {
  $h = @{}
  if ($key) { $h['Authorization'] = "Bearer $key" }
  $p = @{ Uri = "http://127.0.0.1:3199$path"; Method = $method; Headers = $h; UseBasicParsing = $true; TimeoutSec = 30 }
  if ($null -ne $body) { $p['Body'] = ($body | ConvertTo-Json -Depth 6); $p['ContentType'] = 'application/json' }
  try {
    $r = Invoke-WebRequest @p
    return @{ Status = [int]$r.StatusCode; Text = [string]$r.Content }
  } catch {
    $s = 0
    if ($_.Exception.Response) { $s = [int]$_.Exception.Response.StatusCode }
    return @{ Status = $s; Text = $_.Exception.Message }
  }
}

try {
  # 1) auth
  $r = Call '/v1/models' 'GET' $null $null
  Check '401 without key' ($r.Status -eq 401) "got $($r.Status)"
  $r = Call '/v1/models' 'GET'
  Check '200 with key' ($r.Status -eq 200) "got $($r.Status)"

  # 2) merged catalog
  $cat = ($r.Text | ConvertFrom-Json)
  $ids = ($cat.data.id | Sort-Object) -join ','
  Check 'catalog merged A+B+C' ($ids -eq 'deepseek-v4-flash,glm-5.2') "got $ids"

  # 3) deepseek-v4-flash must failover past dead B to A
  $r = Call '/v1/chat/completions' 'POST' @{ model='deepseek-v4-flash'; messages=@(@{role='user';content='hi'}); stream=$false }
  Check 'served by A (failover past dead B)' ($r.Status -eq 200 -and $r.Text -match 'mock-A') "got $($r.Status) $($r.Text.Substring(0, [Math]::Min(120, $r.Text.Length)))"

  # 4) glm-5.2 now offered by both A (priority 1) and C (priority 3):
  #    priority routing must pick A.
  $r = Call '/v1/chat/completions' 'POST' @{ model='glm-5.2'; messages=@(@{role='user';content='hi'}); stream=$false }
  Check 'glm-5.2 priority-routes to A' ($r.Status -eq 200 -and $r.Text -match 'mock-A') "got $($r.Status) $($r.Text.Substring(0, [Math]::Min(120, $r.Text.Length)))"

  # 5) SSE streaming passthrough
  $r = Call '/v1/chat/completions' 'POST' @{ model='deepseek-v4-flash'; messages=@(@{role='user';content='hi'}); stream=$true }
  Check 'SSE passthrough' ($r.Status -eq 200 -and $r.Text -match 'mock-A' -and $r.Text -match '\[DONE\]') "got $($r.Status) $($r.Text.Substring(0, [Math]::Min(160, $r.Text.Length)))"

  # 6) unknown model
  $r = Call '/v1/chat/completions' 'POST' @{ model='no-such'; messages=@() }
  Check 'unknown model 404' ($r.Status -eq 404) "got $($r.Status)"

  # 7) unsupported route
  $r = Call '/v1/whatever' 'GET'
  Check 'unsupported route 404' ($r.Status -eq 404) "got $($r.Status)"

  # 8) /health for assistant probing
  $r = Call '/health' 'GET'
  Check '/health ok' ($r.Status -eq 200) "got $($r.Status)"
} finally {
  Stop-Process -Id $gw.Id, $mock.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "===== $passed passed, $failed failed ====="
exit $(if ($failed -gt 0) { 1 } else { 0 })