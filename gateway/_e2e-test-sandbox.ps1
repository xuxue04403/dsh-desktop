# Gateway E2E (sandbox-safe variant)
# Uses a batch wrapper to start node children (Start-Process bare args are
# unreliable under the harness sandbox; cmd/batch env+quoting matches the
# real C# ProcessStartInfo behavior). Use in sandboxed CI; the plain
# _e2e-test.ps1 remains for local interactive runs.
$ErrorActionPreference = 'Stop'
$gatewayDir = 'D:\IDE\dsh\dsh-desktop-github\gateway'
$tmp = Join-Path $env:TEMP "gw-e2e-$(Get-Random)"
New-Item $tmp -ItemType Directory -Force | Out-Null
$config = @"
{"port":3199,"apiKey":"test-key-123","providers":[
 {"id":"A","baseURL":"http://127.0.0.1:3190/v1","apiKey":"k-a","models":["deepseek-v4-flash","glm-5.2"],"priority":1,"enabled":true},
 {"id":"B","baseURL":"http://127.0.0.1:3191/v1","apiKey":"k-b","models":["deepseek-v4-flash"],"priority":2,"enabled":true},
 {"id":"C","baseURL":"http://127.0.0.1:3192/v1","apiKey":"k-c","models":["glm-5.2"],"priority":3,"enabled":true}
]}
"@
Set-Content -Path (Join-Path $tmp 'gateway.config.json') -Value $config -Encoding ascii

$mockCmd = @"
@echo off
set MOCK_PORT=3190
start "" /b node "$gatewayDir\_mock-upstreams.mjs" > "$tmp\mock.out" 2>&1
"@
Set-Content -Path "$tmp\mock.cmd" -Value $mockCmd -Encoding ascii

$gwCmd = @"
@echo off
set DSH_GATEWAY_CONFIG=$tmp\gateway.config.json
set DSH_GATEWAY_LOG=$tmp\gateway.log
set DSH_GATEWAY_VERBOSE=0
start "" /b node "$gatewayDir\model-gateway.mjs" > "$tmp\gw.out" 2>&1
"@
Set-Content -Path "$tmp\gw.cmd" -Value $gwCmd -Encoding ascii

cmd /c "$tmp\mock.cmd"
cmd /c "$tmp\gw.cmd"
Start-Sleep -Seconds 2

$passed = 0; $failed = 0
function Check($name, $cond, $extra = '') {
  if ($cond) { $script:passed++; Write-Host "  PASS  $name" -ForegroundColor Green }
  else { $script:failed++; Write-Host "  FAIL  $name  $extra" -ForegroundColor Red }
}
function Call($path, $method, $body = $null, $key = 'test-key-123', $extraHeaders = $null) {
  $h = @{}
  if ($key) { $h['Authorization'] = "Bearer $key" }
  if ($extraHeaders) { foreach ($k in $extraHeaders.Keys) { $h[$k] = $extraHeaders[$k] } }
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
  $r = Call '/v1/models' 'GET' $null $null
  Check '401 without key' ($r.Status -eq 401) "got $($r.Status)"
  $r = Call '/v1/models' 'GET'
  Check '200 with key' ($r.Status -eq 200) "got $($r.Status)"

  $cat = ($r.Text | ConvertFrom-Json)
  $ids = ($cat.data.id | Sort-Object) -join ','
  Check 'catalog merged A+B+C' ($ids -eq 'deepseek-v4-flash,glm-5.2') "got $ids"

  $r = Call '/v1/chat/completions' 'POST' @{ model='deepseek-v4-flash'; messages=@(@{role='user';content='hi'}); stream=$false }
  Check 'served by A (failover past dead B)' ($r.Status -eq 200 -and $r.Text -match 'mock-A') "got $($r.Status) $($r.Text.Substring(0, [Math]::Min(120, $r.Text.Length)))"

  $r = Call '/v1/chat/completions' 'POST' @{ model='glm-5.2'; messages=@(@{role='user';content='hi'}); stream=$false }
  Check 'glm-5.2 priority-routes to A' ($r.Status -eq 200 -and $r.Text -match 'mock-A') "got $($r.Status) $($r.Text.Substring(0, [Math]::Min(120, $r.Text.Length)))"

  # K1 防屏蔽透传：客户端带 dsh 风格 User-Agent，上游必须原样收到（mock 回显 echo_ua）
  $dshUA = 'deepseek-harness/0.1.1-test (+https://github.com/deepseek-ai/deepseek-harness)'
  $r = Call '/v1/chat/completions' 'POST' @{ model='deepseek-v4-flash'; messages=@(@{role='user';content='hi'}); stream=$false } 'test-key-123' @{ 'User-Agent' = $dshUA }
  $uaEcho = ($r.Text | ConvertFrom-Json).echo_ua
  Check 'user-agent 透传（dsh 标识保持）' ($uaEcho -eq $dshUA) "got '$uaEcho'"

  $r = Call '/v1/chat/completions' 'POST' @{ model='deepseek-v4-flash'; messages=@(@{role='user';content='hi'}); stream=$true }
  Check 'SSE passthrough' ($r.Status -eq 200 -and $r.Text -match 'mock-A' -and $r.Text -match '\[DONE\]') "got $($r.Status) $($r.Text.Substring(0, [Math]::Min(160, $r.Text.Length)))"

  $r = Call '/v1/chat/completions' 'POST' @{ model='no-such'; messages=@() }
  Check 'unknown model 404' ($r.Status -eq 404) "got $($r.Status)"

  # K7 回归：客户端请求 gzip 时，网关必须强制 identity（SSE 明文透传，不出现乱码）
  $gzTmp = Join-Path $env:TEMP 'gw-e2e-gzip'
  New-Item $gzTmp -ItemType Directory -Force | Out-Null
  @'
{"port":3198,"apiKey":"k","providers":[{"id":"G","baseURL":"http://127.0.0.1:3196/v1","apiKey":"k-g","models":["m"],"priority":1,"enabled":true}]}
'@ | Set-Content "$gzTmp\cfg.json" -Encoding ascii
  $gzMock = "@echo off`nset MOCK_PORT=3196`nstart `"`" /b node `"$gatewayDir\_mock-sse-gzip.mjs`" > `"$gzTmp\mock.out`" 2>&1"
  Set-Content "$gzTmp\mock.cmd" $gzMock -Encoding ascii
  $gzGw = "@echo off`nset DSH_GATEWAY_CONFIG=$gzTmp\cfg.json`nset DSH_GATEWAY_LOG=$gzTmp\gw.log`nset DSH_GATEWAY_VERBOSE=0`nstart `"`" /b node `"$gatewayDir\model-gateway.mjs`" > `"$gzTmp\gw.out`" 2>&1"
  Set-Content "$gzTmp\gw.cmd" $gzGw -Encoding ascii
  cmd /c "$gzTmp\mock.cmd"; cmd /c "$gzTmp\gw.cmd"
  Start-Sleep -Seconds 2
  $gh = @{ Authorization = 'Bearer k'; 'Accept-Encoding' = 'gzip' }
  try {
    $gzResp = Invoke-WebRequest 'http://127.0.0.1:3198/v1/chat/completions' -Method Post -Headers $gh -ContentType 'application/json' -Body '{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":true}' -UseBasicParsing -TimeoutSec 10
    $gzBody = [string]$gzResp.Content
    Check 'gzip 请求强制 identity（SSE 明文不乱码）' ($gzBody -match 'chunk1' -and $gzBody -match '\[DONE\]') "bad gzip passthrough"
  } catch {
    Check 'gzip 请求强制 identity（SSE 明文不乱码）' $false $_.Exception.Message
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*mock-sse-gzip*' -or $_.CommandLine -like '*gateway*3198*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item $gzTmp -Recurse -Force -ErrorAction SilentlyContinue

  $r = Call '/v1/whatever' 'GET'
  Check 'unsupported route 404' ($r.Status -eq 404) "got $($r.Status)"

  $r = Call '/health' 'GET'
  Check '/health ok' ($r.Status -eq 200) "got $($r.Status)"
} finally {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*model-gateway*' -or $_.CommandLine -like '*mock-upstreams*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "===== $passed passed, $failed failed ====="
exit $(if ($failed -gt 0) { 1 } else { 0 })