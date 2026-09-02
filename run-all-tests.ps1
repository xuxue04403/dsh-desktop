# ============================================================
# DSH Desktop 一键回归测试（run-all-tests.ps1）
# 覆盖：编译、网关 E2E、崩溃面、YAML 注入、端口同步、数据目录
# 用法：powershell -ExecutionPolicy Bypass -File run-all-tests.ps1
# 任一失败退出码非 0（CI 可用）
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$passed = 0; $failed = 0
function Pass($name) { $script:passed++; Write-Host "  PASS  $name" -ForegroundColor Green }
function Fail($name, $extra) { $script:failed++; Write-Host "  FAIL  $name  $extra" -ForegroundColor Red }

Write-Host '===== 1. 编译检查 ====='
# 直接执行（不要用管道包裹 build.ps1——沙箱禁止管道捕获子进程 stdout）
& (Join-Path $root 'build.ps1')
if ($LASTEXITCODE -eq 0) { Pass 'C# 编译（零错误）' } else { Fail 'C# 编译' "exit=$LASTEXITCODE" }

Write-Host '===== 2. 网关 E2E（9 项，沙箱安全版）====='
# 不捕获输出（沙箱禁止输出捕获链），仅以退出码判定；E2E 脚本自身会打印明细
& (Join-Path $root 'gateway\_e2e-test-sandbox.ps1')
if ($LASTEXITCODE -eq 0) { Pass '网关 E2E 9/9' } else { Fail '网关 E2E' "exit=$LASTEXITCODE" }

Write-Host '===== 3. 关键方法存在性（反射）====='
$asm = [Reflection.Assembly]::LoadFrom((Join-Path $root 'DSHDesktop.exe'))
$t = $asm.GetType('DSHDesktop.MainForm')
$bf = [System.Reflection.BindingFlags]'Instance,Static,Public,NonPublic'
$methods = @('StartService','StopService','StartGateway','StopGateway','SyncGwKeyToConfig','WriteGatewayToDsh','CheckThenStart','ResolveDataDir','GatewayIsRunningHttpOnly')
$missing = @($methods | Where-Object { -not $t.GetMethod($_, $bf) })
if ($missing.Count -eq 0) { Pass "关键方法 ${($methods.Count)} 个全部存在" } else { Fail '关键方法缺失' ($missing -join ',') }

Write-Host '===== 4. 版本对比逻辑（单元）====='
$iv = $t.GetMethod('IsNewerVersion', $bf)
$expect = @(
  @('0.2.0','0.1.0',$true),
  @('0.1.0','0.1.0',$false),
  @('1.0.0','0.9.9',$true),
  @('0.1.1-rc.2','0.1.1-rc.2',$false)
)
$okAll = $true
foreach ($c in $expect) {
  $r = $iv.Invoke($null, [object[]]@($c[0],$c[1]))
  if ($r -ne $c[2]) { $okAll = $false; Fail "版本比较 $($c[0]) vs $($c[1])" "got $r" }
}
if ($okAll) { Pass '版本比较 4 组用例' }

Write-Host '===== 5. 无警告编译 ====='
# /warnaserror：任何警告视为错误 → 以退出码判定；不捕获输出（沙箱限制）
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /platform:anycpu /warn:4 /warnaserror "/out:$env:TEMP\dsh-warncheck.exe" "/win32icon:$root\app.ico" /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "$root\DSHDesktop.cs"
if ($LASTEXITCODE -eq 0) { Pass '编译零警告（warnaserror）' } else { Fail '编译有警告/错误' "exit=$LASTEXITCODE" }
Remove-Item "$env:TEMP\dsh-warncheck.exe" -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "===== $passed passed, $failed failed ====="
exit $(if ($failed -gt 0) { 1 } else { 0 })