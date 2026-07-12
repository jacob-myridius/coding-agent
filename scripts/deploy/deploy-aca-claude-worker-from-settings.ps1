[CmdletBinding()]
param(
  [string]$SettingsFile = ".\local.settings.prod.json",
  [string]$DeployScriptPath = ".\scripts\deploy\deploy-aca-claude-worker.ps1",
  [string]$RegistryName = "",
  [string]$EventHubConnectionString = "",
  [string]$AzdoPat = "",
  [string]$AzdoRepo = "",
  [string]$AzdoRepoCloneUrl = "",
  [switch]$Preview
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-EnvironmentValue {
  param([string]$Name)

  foreach ($scope in @("Process", "User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable($Name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value
    }
  }

  return ""
}

function Resolve-SettingValue {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }

  if ($Value -match '^%([A-Za-z_][A-Za-z0-9_]*)%$') {
    $envName = $Matches[1]
    $resolved = Get-EnvironmentValue $envName
    if ([string]::IsNullOrWhiteSpace($resolved)) {
      if (-not $script:UnresolvedPlaceholders.Contains($envName)) {
        $script:UnresolvedPlaceholders.Add($envName) | Out-Null
      }
      return ""
    }
    return $resolved
  }

  return $Value
}

function Resolve-InputValue {
  param(
    [string]$Explicit,
    [string[]]$EnvKeys
  )

  if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
    return $Explicit
  }

  foreach ($key in $EnvKeys) {
    $value = Get-EnvironmentValue $key
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value
    }
  }

  return ""
}

function Is-SensitiveKey {
  param([string]$Key)

  $upper = $Key.ToUpperInvariant()
  return $upper.Contains("PAT") -or $upper.Contains("KEY") -or $upper.Contains("SECRET") -or $upper.Contains("CONNECTION_STRING")
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$settingsPathResolved = if ([System.IO.Path]::IsPathRooted($SettingsFile)) {
  $SettingsFile
} else {
  Join-Path $repoRoot $SettingsFile
}
$deployScriptResolved = if ([System.IO.Path]::IsPathRooted($DeployScriptPath)) {
  $DeployScriptPath
} else {
  Join-Path $repoRoot $DeployScriptPath
}

if (-not (Test-Path -LiteralPath $settingsPathResolved)) {
  throw "Settings file not found: $settingsPathResolved"
}
if (-not (Test-Path -LiteralPath $deployScriptResolved)) {
  throw "Deploy script not found: $deployScriptResolved"
}

$settingsJson = Get-Content $settingsPathResolved -Raw | ConvertFrom-Json
if (-not $settingsJson.Values) {
  throw "Invalid settings file: missing Values object"
}

$script:UnresolvedPlaceholders = [System.Collections.Generic.List[string]]::new()

foreach ($prop in $settingsJson.Values.PSObject.Properties) {
  $resolvedValue = Resolve-SettingValue ([string]$prop.Value)
  if ($resolvedValue -ne "") {
    [Environment]::SetEnvironmentVariable($prop.Name, $resolvedValue)
  }
}

$resolvedRegistryName = Resolve-InputValue $RegistryName @("AZURE_ACR_NAME")
$resolvedEventHubConnectionString = Resolve-InputValue $EventHubConnectionString @("AZURE_ADO_IMPLEMENTATION_EVENTHUB_CONNECTION_STRING")
$resolvedAzdoPat = Resolve-InputValue $AzdoPat @("MYRIDIUS_DEVOPS_PAT", "AZDO_PAT")
$resolvedAzdoRepo = Resolve-InputValue $AzdoRepo @("AZDO_REPO")
$resolvedAzdoRepoCloneUrl = Resolve-InputValue $AzdoRepoCloneUrl @("AZDO_REPO_CLONE_URL")

if ([string]::IsNullOrWhiteSpace($resolvedRegistryName)) {
  throw "Missing RegistryName. Provide -RegistryName or set AZURE_ACR_NAME."
}
if ([string]::IsNullOrWhiteSpace($resolvedEventHubConnectionString)) {
  throw "Missing EventHubConnectionString. Provide -EventHubConnectionString or set AZURE_ADO_IMPLEMENTATION_EVENTHUB_CONNECTION_STRING."
}
if ([string]::IsNullOrWhiteSpace($resolvedAzdoPat)) {
  throw "Missing AzdoPat. Provide -AzdoPat or set MYRIDIUS_DEVOPS_PAT/AZDO_PAT."
}
if ([string]::IsNullOrWhiteSpace($resolvedAzdoRepo)) {
  throw "Missing AzdoRepo. Provide -AzdoRepo or set AZDO_REPO."
}
if ([string]::IsNullOrWhiteSpace($resolvedAzdoRepoCloneUrl)) {
  throw "Missing AzdoRepoCloneUrl. Provide -AzdoRepoCloneUrl or set AZDO_REPO_CLONE_URL."
}

$deployArgs = [ordered]@{
  RegistryName = $resolvedRegistryName
  EventHubConnectionString = $resolvedEventHubConnectionString
  AzdoPat = $resolvedAzdoPat
  AzdoRepo = $resolvedAzdoRepo
  AzdoRepoCloneUrl = $resolvedAzdoRepoCloneUrl
}

if ($Preview) {
  Write-Host "Preview mode: settings resolved and deployment command prepared." -ForegroundColor Cyan
  Write-Host "Settings file: $settingsPathResolved" -ForegroundColor DarkCyan
  Write-Host "Deploy script: $deployScriptResolved" -ForegroundColor DarkCyan

  foreach ($entry in $deployArgs.GetEnumerator()) {
    $value = if (Is-SensitiveKey $entry.Key) { "***" } else { $entry.Value }
    Write-Host ("{0}={1}" -f $entry.Key, $value)
  }
  if ($script:UnresolvedPlaceholders.Count -gt 0) {
    Write-Host "Unresolved placeholders (ignored unless required by deploy): $($script:UnresolvedPlaceholders -join ', ')" -ForegroundColor Yellow
  }
  return
}

& $deployScriptResolved @deployArgs




