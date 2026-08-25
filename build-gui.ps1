param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "dist\DeepSeekProxyManager"),
  [string]$NodePath = "",
  [switch]$SkipBundledNode
)

$ErrorActionPreference = "Stop"

$compilerCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) {
  throw "Cannot find the .NET Framework C# compiler (csc.exe)."
}

$sourcePath = Join-Path $PSScriptRoot "desktop\DeepSeekProxyManager.cs"
$trayThemeSourcePath = Join-Path $PSScriptRoot "desktop\TrayMenuTheme.cs"
$proxyPath = Join-Path $PSScriptRoot "claude-deepseek-proxy.mjs"
$iconPath = Join-Path $PSScriptRoot "assets\DeepSeekProxyManager.ico"
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Missing GUI source: $sourcePath"
}
if (-not (Test-Path -LiteralPath $trayThemeSourcePath -PathType Leaf)) {
  throw "Missing tray menu theme: $trayThemeSourcePath"
}
if (-not (Test-Path -LiteralPath $proxyPath -PathType Leaf)) {
  throw "Missing proxy core: $proxyPath"
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "Missing application icon: $iconPath"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = Join-Path $OutputDirectory "DeepSeekProxyManager.exe"

function Resolve-FrameworkAssembly {
  param([Parameter(Mandatory = $true)][string]$Name)

  $frameworkFile = Join-Path (Split-Path -Parent $compiler) "$Name.dll"
  if (Test-Path -LiteralPath $frameworkFile -PathType Leaf) {
    return $frameworkFile
  }

  $gacRoots = @(
    "$env:WINDIR\Microsoft.NET\assembly\GAC_MSIL\$Name",
    "$env:WINDIR\Microsoft.NET\assembly\GAC_64\$Name",
    "$env:WINDIR\Microsoft.NET\assembly\GAC_32\$Name"
  )
  foreach ($root in $gacRoots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    $match = Get-ChildItem -LiteralPath $root -Recurse -Filter "$Name.dll" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($match) { return $match.FullName }
  }

  throw "Cannot find required .NET Framework assembly: $Name.dll"
}

$references = @(
  "PresentationCore",
  "PresentationFramework",
  "WindowsBase",
  "System.Xaml",
  "System.Windows.Forms",
  "System.Drawing",
  "System.Security"
) | ForEach-Object { Resolve-FrameworkAssembly -Name $_ }

$compilerArguments = @(
  "/nologo",
  "/target:winexe",
  "/platform:anycpu",
  "/optimize+",
  "/warn:4",
  "/win32icon:$iconPath",
  "/out:$outputPath",
  $sourcePath,
  $trayThemeSourcePath
)
$compilerArguments += $references | ForEach-Object { "/reference:$_" }

Write-Host "Compiling WPF manager with: $compiler"
& $compiler $compilerArguments
if ($LASTEXITCODE -ne 0) {
  throw "GUI compilation failed with exit code $LASTEXITCODE."
}

Copy-Item -LiteralPath $proxyPath -Destination (Join-Path $OutputDirectory "claude-deepseek-proxy.mjs") -Force
Copy-Item -LiteralPath $iconPath -Destination (Join-Path $OutputDirectory "DeepSeekProxyManager.ico") -Force
Copy-Item -LiteralPath $trayThemeSourcePath -Destination (Join-Path $OutputDirectory "TrayMenuTheme.cs") -Force

function Resolve-NodeExecutable {
  param([string]$RequestedPath)

  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf)) {
      throw "NodePath does not exist: $RequestedPath"
    }
    return (Resolve-Path -LiteralPath $RequestedPath).Path
  }

  $candidates = @(
    (Join-Path $PSScriptRoot "node.exe"),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "nodejs\node.exe" }),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe" })
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  throw "Cannot find Node.js 20+. Install it for the build, or pass -NodePath C:\path\to\node.exe."
}

if (-not $SkipBundledNode) {
  $nodeExe = Resolve-NodeExecutable -RequestedPath $NodePath
  $nodeVersion = (& $nodeExe -p "process.versions.node").Trim()
  $nodeMajor = 0
  if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse($nodeVersion.Split('.')[0], [ref]$nodeMajor) -or $nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required for a portable build. Found v$nodeVersion at: $nodeExe"
  }

  Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $OutputDirectory "node.exe") -Force
  $nodeLicense = Join-Path (Split-Path -Parent $nodeExe) "LICENSE"
  if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) {
    $nodeLicense = Join-Path $PSScriptRoot "third_party\NODE-LICENSE.txt"
  }
  if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $OutputDirectory "NODE-LICENSE.txt") -Force
  } else {
    throw "No Node.js license notice was found. Add third_party\NODE-LICENSE.txt before external redistribution."
  }
  Write-Host "Bundled Node.js v$nodeVersion from: $nodeExe"
}

$sourceText = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
function Export-EmbeddedXaml {
  param(
    [Parameter(Mandatory = $true)][string]$ConstantName,
    [Parameter(Mandatory = $true)][string]$FileName
  )

  $pattern = '(?s)private const string ' + [regex]::Escape($ConstantName) + ' = @"(.*?)";'
  $xamlMatch = [regex]::Match($sourceText, $pattern)
  if (-not $xamlMatch.Success) {
    throw "Cannot extract embedded XAML constant: $ConstantName"
  }
  $xamlText = $xamlMatch.Groups[1].Value.Replace('""', '"')
  [IO.File]::WriteAllText(
    (Join-Path $OutputDirectory $FileName),
    $xamlText,
    (New-Object Text.UTF8Encoding($true))
  )
}

Export-EmbeddedXaml -ConstantName "WindowXaml" -FileName "ManagerWindow.xaml"
Export-EmbeddedXaml -ConstantName "GatewayKeyWindowXaml" -FileName "GatewayKeyWindow.xaml"
Export-EmbeddedXaml -ConstantName "LogWindowXaml" -FileName "LogWindow.xaml"

$powerShellSource = [IO.File]::ReadAllText(
  (Join-Path $PSScriptRoot "desktop\DeepSeekProxyManager.ps1"),
  [Text.Encoding]::UTF8
)
[IO.File]::WriteAllText(
  (Join-Path $OutputDirectory "DeepSeekProxyManager.ps1"),
  $powerShellSource,
  (New-Object Text.UTF8Encoding($true))
)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "desktop\Launch-DeepSeekProxyManager.cmd") `
  -Destination (Join-Path $OutputDirectory "Launch-DeepSeekProxyManager.cmd") -Force

Write-Host "Built: $outputPath"
Write-Host "Managed Windows entry: $(Join-Path $OutputDirectory 'Launch-DeepSeekProxyManager.cmd')"
if ($SkipBundledNode) {
  Write-Host "Node.js was not bundled. The target PC must have Node.js 20+ installed or node.exe placed beside the launchers."
} else {
  Write-Host "Portable output is ready. Copy the entire output folder; the target PC does not need Node.js installed."
}
