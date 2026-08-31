$ErrorActionPreference = 'Stop'

# Execute the real production health methods with in-memory dependencies.
# No application window, registry access, live listener, or production process is used.
$cs = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\desktop\DeepSeekProxyManager.cs') -Encoding UTF8 -Raw
$ps = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\desktop\DeepSeekProxyManager.ps1') -Encoding UTF8 -Raw

function Get-MethodText([string]$StartMarker, [string]$EndMarker) {
  $start = $cs.IndexOf($StartMarker)
  $end = $cs.IndexOf($EndMarker, $start)
  if ($start -lt 0 -or $end -le $start) { throw "Cannot extract method: $StartMarker" }
  return $cs.Substring($start, $end - $start)
}

$refreshMethod = Get-MethodText 'private async Task RefreshHealthAsync()' 'private async Task<bool> IsProxyHealthyAsync()'
$releaseMethod = Get-MethodText 'private void ReleaseExitedProxyProcess()' 'private static string QuoteArgument('
$threshold = [regex]::Match($cs, 'private const int HealthFailureThreshold = \d+;').Value
if (-not $threshold) { throw 'Missing C# health failure threshold' }

$harness = @'
using System;
using System.Threading.Tasks;

public class HealthStateRegression
{
    private class FakeProcess
    {
        public bool HasExited;
        public bool Disposed;
        public void Dispose() { Disposed = true; }
    }
    private enum StatusKind { Success, Starting, Error, Stopped }
    /* THRESHOLD */
    private int _consecutiveHealthFailures;
    private bool _refreshingHealth;
    private bool _externalProxyDetected;
    private bool _exiting;
    private FakeProcess _proxyProcess = new FakeProcess();
    private bool healthy;
    private int probes;
    private TaskCompletionSource<bool> pending;
    private StatusKind status = StatusKind.Success;
    private bool running;
    private bool owned;

    private Task<bool> IsProxyHealthyAsync()
    {
        probes++;
        return pending == null ? Task.FromResult(healthy) : pending.Task;
    }
    private void TryGetPortSilently(out int port) { port = 3210; }
    private void SetStatus(StatusKind kind, string title, string detail) { status = kind; }
    private void UpdateButtonState(bool isRunning, bool isOwned) { running = isRunning; owned = isOwned; }
    /* REFRESH */
    /* RELEASE */

    private static int assertions;
    private static void Check(bool condition, string name)
    {
        assertions++;
        if (!condition) throw new Exception("C# health regression: " + name);
    }
    private void Poll() { RefreshHealthAsync().GetAwaiter().GetResult(); }

    public static int Run()
    {
        var d = new HealthStateRegression();
        Check(HealthFailureThreshold == 3, "three consecutive failures required");
        for (int i = 1; i <= 2; i++)
        {
            d.Poll();
            Check(d.status == StatusKind.Starting && d._consecutiveHealthFailures == i, "transient failure " + i);
            Check(d.running && d.owned, "keep stop/restart available " + i);
        }
        d.Poll();
        Check(d.status == StatusKind.Error && d._consecutiveHealthFailures == 3, "third failure becomes unhealthy");
        Check(d.running && d.owned && !d._externalProxyDetected, "unhealthy owned process keeps safe controls");
        for (int i = 0; i < 5; i++) d.Poll();
        Check(d._consecutiveHealthFailures == 3, "counter is capped");
        d.healthy = true;
        d.Poll();
        Check(d.status == StatusKind.Success && d._consecutiveHealthFailures == 0, "automatic recovery");
        d.healthy = false;
        d.Poll();
        Check(d.status == StatusKind.Starting && d._consecutiveHealthFailures == 1, "new failure streak starts at one");
        d.healthy = true;
        d.Poll();
        d.healthy = false;
        d.Poll();
        Check(d._consecutiveHealthFailures == 1, "isolated failures do not accumulate");

        d._proxyProcess = null;
        d.Poll();
        Check(d.status == StatusKind.Stopped && !d.running && !d.owned && d._consecutiveHealthFailures == 0, "stopped and reset");
        d.healthy = true;
        d.Poll();
        Check(d.status == StatusKind.Success && d.running && !d.owned && d._externalProxyDetected, "external process not owned");

        d._proxyProcess = new FakeProcess { HasExited = true };
        var exited = d._proxyProcess;
        d._consecutiveHealthFailures = 2;
        d.Poll();
        Check(d.status == StatusKind.Error && !d.running && d._proxyProcess == null && exited.Disposed, "process exit detection");
        Check(d._consecutiveHealthFailures == 0 && !d._externalProxyDetected, "process exit resets state");

        d = new HealthStateRegression();
        d.pending = new TaskCompletionSource<bool>();
        var oldProbe = d.RefreshHealthAsync();
        d.RefreshHealthAsync().GetAwaiter().GetResult();
        Check(d.probes == 1, "overlapping poll is ignored");
        d._proxyProcess = new FakeProcess();
        d.status = StatusKind.Starting;
        d.pending.SetResult(true);
        oldProbe.GetAwaiter().GetResult();
        Check(d.status == StatusKind.Starting && d._consecutiveHealthFailures == 0, "stale success after restart ignored");
        Check(!d._refreshingHealth, "probe lock released");
        d.pending = null;
        d.Poll();
        Check(d._consecutiveHealthFailures == 1, "new process can be probed");

        d = new HealthStateRegression();
        d.pending = new TaskCompletionSource<bool>();
        oldProbe = d.RefreshHealthAsync();
        d._proxyProcess = null;
        d.status = StatusKind.Stopped;
        d.pending.SetResult(true);
        oldProbe.GetAwaiter().GetResult();
        Check(d.status == StatusKind.Stopped, "stale success after stop ignored");

        d = new HealthStateRegression();
        d.pending = new TaskCompletionSource<bool>();
        oldProbe = d.RefreshHealthAsync();
        d._proxyProcess.HasExited = true;
        d.pending.SetResult(true);
        oldProbe.GetAwaiter().GetResult();
        Check(d.status == StatusKind.Error && d._proxyProcess == null, "exit while awaiting health wins over stale success");

        d = new HealthStateRegression();
        d.pending = new TaskCompletionSource<bool>();
        oldProbe = d.RefreshHealthAsync();
        d._exiting = true;
        d.status = StatusKind.Stopped;
        d.pending.SetResult(false);
        oldProbe.GetAwaiter().GetResult();
        Check(d.status == StatusKind.Stopped && d._consecutiveHealthFailures == 0, "shutdown ignores pending failure");
        return assertions;
    }
}
'@
Add-Type -TypeDefinition ($harness.Replace('/* THRESHOLD */', $threshold).Replace('/* REFRESH */', $refreshMethod).Replace('/* RELEASE */', $releaseMethod))
$csharpAssertions = [HealthStateRegression]::Run()

$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($ps, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'PowerShell launcher has syntax errors' }
$functionAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Refresh-Health' }, $true)
if (-not $functionAst) { throw 'Missing PowerShell Refresh-Health function' }
. ([scriptblock]::Create($functionAst.Extent.Text))
$thresholdMatch = [regex]::Match($ps, '\$script:healthFailureThreshold = (\d+)')
if (-not $thresholdMatch.Success) { throw 'Missing PowerShell threshold' }
$script:healthFailureThreshold = [int]$thresholdMatch.Groups[1].Value
$script:consecutiveHealthFailures = 0
$script:externalProxy = $false
$script:healthy = $false
$script:status = 'Success'
$script:running = $false
$script:owned = $false
$script:psAssertions = 0
$portBox = [pscustomobject]@{ Text = '3210' }

function Test-ProxyHealth { return $script:healthy }
function Set-Status($Kind, $Title, $Detail) { $script:status = [string]$Kind }
function Update-Buttons([bool]$Running, [bool]$Owned) { $script:running = $Running; $script:owned = $Owned }
function Assert-Health([bool]$Condition, [string]$Name) {
  $script:psAssertions++
  if (-not $Condition) { throw "PowerShell health regression: $Name" }
}
function New-FakeProcess {
  $value = [pscustomobject]@{ HasExited = $false; Disposed = $false }
  $value | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.Disposed = $true }
  return $value
}

$script:ownedProcess = New-FakeProcess
Assert-Health ($script:healthFailureThreshold -eq 3) 'three failures required'
foreach ($count in 1,2) {
  Refresh-Health
  Assert-Health ($script:status -eq 'Starting' -and $script:consecutiveHealthFailures -eq $count) "transient failure $count"
  Assert-Health ($script:running -and $script:owned) "safe controls $count"
}
Refresh-Health
Assert-Health ($script:status -eq 'Error' -and $script:consecutiveHealthFailures -eq 3) 'third failure becomes unhealthy'
Assert-Health ($script:running -and $script:owned -and -not $script:externalProxy) 'unhealthy controls'
1..5 | ForEach-Object { Refresh-Health }
Assert-Health ($script:consecutiveHealthFailures -eq 3) 'counter capped'
$script:healthy = $true
Refresh-Health
Assert-Health ($script:status -eq 'Success' -and $script:consecutiveHealthFailures -eq 0) 'recovery'
$script:healthy = $false
Refresh-Health
Assert-Health ($script:status -eq 'Starting' -and $script:consecutiveHealthFailures -eq 1) 'reset streak'
$script:ownedProcess = $null
Refresh-Health
Assert-Health ($script:status -eq 'Stopped' -and -not $script:running -and $script:consecutiveHealthFailures -eq 0) 'stopped'
$script:healthy = $true
Refresh-Health
Assert-Health ($script:status -eq 'Success' -and $script:running -and -not $script:owned -and $script:externalProxy) 'external process'
$script:ownedProcess = New-FakeProcess
$exited = $script:ownedProcess
$exited.HasExited = $true
$script:consecutiveHealthFailures = 2
Refresh-Health
Assert-Health ($script:status -eq 'Error' -and -not $script:running -and $null -eq $script:ownedProcess -and $exited.Disposed) 'exited process'
Assert-Health ($script:consecutiveHealthFailures -eq 0 -and -not $script:externalProxy) 'exit resets state'

[pscustomobject]@{ csharpAssertions = $csharpAssertions; powershellAssertions = $script:psAssertions } | ConvertTo-Json -Compress
