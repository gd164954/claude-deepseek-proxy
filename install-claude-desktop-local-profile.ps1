param(
  [string]$ProxyApiKey = $env:PROXY_API_KEY,
  [string]$GatewayBaseUrl = "http://127.0.0.1:3210",
  [string]$ProfileName = "CC Switch",
  [string]$ProfileId = "00000000-0000-4000-8000-000000157210",
  [string]$ClaudeDir = "$env:LOCALAPPDATA\Claude",
  [string]$Claude3pDir = "$env:LOCALAPPDATA\Claude-3p",
  [switch]$PatchAppliedProfile
)

if ([string]::IsNullOrWhiteSpace($ProxyApiKey)) {
  throw "Missing proxy API key. Example: .\install-claude-desktop-local-profile.ps1 -ProxyApiKey your-local-proxy-key"
}

$configLibraryDir = Join-Path $Claude3pDir "configLibrary"
$metaPath = Join-Path $configLibraryDir "_meta.json"
$profilePath = Join-Path $configLibraryDir "$ProfileId.json"
$normalConfigPath = Join-Path $ClaudeDir "claude_desktop_config.json"
$mainConfigPath = Join-Path $Claude3pDir "claude_desktop_config.json"
$backupRoot = Join-Path (Get-Location) "backups"
$backupDir = Join-Path $backupRoot ("claude-3p-config-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

New-Item -ItemType Directory -Force -Path $configLibraryDir | Out-Null
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

if (Test-Path -LiteralPath $normalConfigPath) {
  Copy-Item -LiteralPath $normalConfigPath -Destination (Join-Path $backupDir "Claude.claude_desktop_config.json") -Force
}

if (Test-Path -LiteralPath $mainConfigPath) {
  Copy-Item -LiteralPath $mainConfigPath -Destination (Join-Path $backupDir "Claude-3p.claude_desktop_config.json") -Force
}

if (Test-Path -LiteralPath $metaPath) {
  Copy-Item -LiteralPath $metaPath -Destination (Join-Path $backupDir "_meta.json") -Force
}

Get-ChildItem -LiteralPath $configLibraryDir -Filter "*.json" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne "_meta.json" } |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $backupDir $_.Name) -Force
  }

function Write-DeploymentMode {
  param([string]$Path)

  if (Test-Path -LiteralPath $Path) {
    $config = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } else {
    $config = [pscustomobject]@{}
  }

  $config | Add-Member -NotePropertyName "deploymentMode" -NotePropertyValue "3p" -Force
  $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

Write-DeploymentMode -Path $normalConfigPath
Write-DeploymentMode -Path $mainConfigPath

if (Test-Path -LiteralPath $metaPath) {
  $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
} else {
  $meta = [pscustomobject]@{
    appliedId = $ProfileId
    entries = @()
  }
}

if ($PatchAppliedProfile -and -not [string]::IsNullOrWhiteSpace($meta.appliedId)) {
  $ProfileId = $meta.appliedId
  $currentEntry = @($meta.entries) | Where-Object { $_.id -eq $ProfileId } | Select-Object -First 1
  if ($currentEntry -and -not [string]::IsNullOrWhiteSpace($currentEntry.name)) {
    $ProfileName = $currentEntry.name
  }
  $profilePath = Join-Path $configLibraryDir "$ProfileId.json"
}

$entries = @(@($meta.entries) | Where-Object { $_.id -ne $ProfileId })
$entries += [pscustomobject]@{
  id = $ProfileId
  name = $ProfileName
}

$meta | Add-Member -NotePropertyName "appliedId" -NotePropertyValue $ProfileId -Force
$meta | Add-Member -NotePropertyName "entries" -NotePropertyValue $entries -Force
$meta | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $metaPath -Encoding UTF8

$profile = [ordered]@{
  coworkEgressAllowedHosts = @("*")
  disableDeploymentModeChooser = $true
  inferenceProvider = "gateway"
  inferenceCredentialKind = "static"
  inferenceGatewayBaseUrl = $GatewayBaseUrl
  inferenceGatewayApiKey = $ProxyApiKey
  inferenceGatewayAuthScheme = "bearer"
  inferenceModels = @(
    [ordered]@{
      name = "claude-opus-4-5"
      supports1m = $true
    },
    [ordered]@{
      name = "claude-sonnet-4-5"
      supports1m = $true
    }
  )
}

$profile | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $profilePath -Encoding UTF8

Write-Host "Backed up Claude-3p config to: $backupDir"
Write-Host "Installed Claude Desktop local gateway profile:"
Write-Host "  Profile: $ProfileName"
Write-Host "  URL:     $GatewayBaseUrl"
Write-Host "  Models:  claude-opus-4-5, claude-sonnet-4-5"
Write-Host ""
Write-Host "Next: fully quit Claude Desktop, start the local proxy, then reopen Claude Desktop."
