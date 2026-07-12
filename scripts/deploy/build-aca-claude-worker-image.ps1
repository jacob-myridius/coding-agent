param(
  [string]$ResourceGroup = "rg-training",
  [string]$RegistryName = "",
  [string]$ImageName = "myridius-aca-claude-worker",
  [string]$ImageTag = "0.1.0",
  [string]$BuildContextPath = ".",
  [string]$DockerfilePath = "worker/Dockerfile"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RegistryName)) {
  throw "-RegistryName is required (existing ACR name)."
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$buildContext = if ([System.IO.Path]::IsPathRooted($BuildContextPath)) {
  $BuildContextPath
} else {
  Join-Path $repoRoot $BuildContextPath
}

if (-not (Test-Path -LiteralPath (Join-Path $buildContext "Dockerfile"))) {
  $dockerfileResolved = if ([System.IO.Path]::IsPathRooted($DockerfilePath)) {
    $DockerfilePath
  } else {
    Join-Path $repoRoot $DockerfilePath
  }

  if (-not (Test-Path -LiteralPath $dockerfileResolved)) {
    throw "Dockerfile not found: $dockerfileResolved"
  }
}

$fullImage = "$ImageName`:$ImageTag"

Write-Host "Building ACA worker image in ACR..." -ForegroundColor Cyan
az acr build --registry $RegistryName --resource-group $ResourceGroup --file $DockerfilePath --image $fullImage $buildContext
if ($LASTEXITCODE -ne 0) {
  throw "az acr build failed"
}

Write-Host "Built image: $RegistryName.azurecr.io/$fullImage" -ForegroundColor Green



