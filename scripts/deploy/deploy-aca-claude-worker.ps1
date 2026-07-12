param(
  [string]$ResourceGroup = $(if (-not [string]::IsNullOrWhiteSpace($env:AZURE_ACA_RESOURCE_GROUP)) { $env:AZURE_ACA_RESOURCE_GROUP } else { "rg-training" }),
  [string]$Location = $(if (-not [string]::IsNullOrWhiteSpace($env:AZURE_ACA_LOCATION)) { $env:AZURE_ACA_LOCATION } else { "southeastasia" }),
  [string]$ContainerAppEnvName = $(if (-not [string]::IsNullOrWhiteSpace($env:AZURE_ACA_ENV_NAME)) { $env:AZURE_ACA_ENV_NAME } else { "myridius-aca-env-uat-sea" }),
  [string]$ContainerAppName = $(if (-not [string]::IsNullOrWhiteSpace($env:AZURE_ACA_WORKER_APP_NAME)) { $env:AZURE_ACA_WORKER_APP_NAME } else { "myridius-aca-cldwrk-uat-sea" }),
  [string]$RegistryName = $(if (-not [string]::IsNullOrWhiteSpace($env:AZURE_ACR_NAME)) { $env:AZURE_ACR_NAME } else { "" }),
  [string]$ImageName = "myridius-aca-claude-worker",
  [string]$ImageTag = "0.1.0",
  [string]$EventHubConnectionString = $(if (-not [string]::IsNullOrWhiteSpace($env:AZURE_ADO_IMPLEMENTATION_EVENTHUB_CONNECTION_STRING)) { $env:AZURE_ADO_IMPLEMENTATION_EVENTHUB_CONNECTION_STRING } else { "" }),
  [string]$EventHubName = $(if (-not [string]::IsNullOrWhiteSpace($env:AZURE_ADO_IMPLEMENTATION_EVENTHUB_NAME)) { $env:AZURE_ADO_IMPLEMENTATION_EVENTHUB_NAME } else { "myridius-implementation-events" }),
  [string]$EventHubConsumerGroup = "claude-code-worker",
  [string]$AzdoPat = "",
  [string]$AzdoOrg = "myridius-devops-sandbox",
  [string]$AzdoProject = "avvance-connect-payment",
  [string]$AzdoRepo = "",
  [string]$AzdoRepoCloneUrl = "",
  [string]$MyridiusOpenAiApiKey = $(if (-not [string]::IsNullOrWhiteSpace($env:MYRIDIUS_OPENAI_API_KEY)) { $env:MYRIDIUS_OPENAI_API_KEY } else { "" }),
  [string]$MyridiusOpenAiModelEndpoint = $(if (-not [string]::IsNullOrWhiteSpace($env:MYRIDIUS_OPENAI_MODEL_ENDPOINT)) { $env:MYRIDIUS_OPENAI_MODEL_ENDPOINT } else { "" }),
  [string]$MyridiusOpenAiDeploymentName = $(if (-not [string]::IsNullOrWhiteSpace($env:MYRIDIUS_OPENAI_DEPLOYMENT_NAME)) { $env:MYRIDIUS_OPENAI_DEPLOYMENT_NAME } else { "" }),
  [string]$GitUserName = "Myridius DevOpsAgent",
  [string]$GitEmail = "DevOpsAgent@myridius.com"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RegistryName)) { throw "-RegistryName is required." }
if ([string]::IsNullOrWhiteSpace($EventHubConnectionString)) { throw "-EventHubConnectionString is required." }
if ([string]::IsNullOrWhiteSpace($AzdoPat)) { throw "-AzdoPat is required." }
if ([string]::IsNullOrWhiteSpace($AzdoRepo)) { throw "-AzdoRepo is required." }
if ([string]::IsNullOrWhiteSpace($AzdoRepoCloneUrl)) { throw "-AzdoRepoCloneUrl is required." }
if ([string]::IsNullOrWhiteSpace($MyridiusOpenAiApiKey)) { throw "-MyridiusOpenAiApiKey is required." }
if ([string]::IsNullOrWhiteSpace($MyridiusOpenAiModelEndpoint)) { throw "-MyridiusOpenAiModelEndpoint is required." }
if ([string]::IsNullOrWhiteSpace($MyridiusOpenAiDeploymentName)) { throw "-MyridiusOpenAiDeploymentName is required." }

$acrServer = "{0}.azurecr.io" -f $RegistryName
$image = "$acrServer/$ImageName`:$ImageTag"

Write-Host "Ensuring Container Apps environment exists..." -ForegroundColor Cyan
$envExists = az containerapp env show --name $ContainerAppEnvName --resource-group $ResourceGroup --only-show-errors 2>$null
if ($LASTEXITCODE -ne 0) {
  az containerapp env create --name $ContainerAppEnvName --resource-group $ResourceGroup --location $Location --only-show-errors | Out-Null
}

Write-Host "Fetching ACR credentials..." -ForegroundColor Cyan
$acrUser = az acr credential show --name $RegistryName --query username -o tsv
$acrPass = az acr credential show --name $RegistryName --query "passwords[0].value" -o tsv

Write-Host "Deploying ACA worker revision..." -ForegroundColor Cyan
$containerAppCount = az containerapp list --resource-group $ResourceGroup --query "[?name=='$ContainerAppName'] | length(@)" -o tsv
$containerAppExists = ($LASTEXITCODE -eq 0 -and [int]$containerAppCount -gt 0)
$envVarsArgs = @(
  "EVENT_HUB_CONNECTION_STRING=secretref:eventhub-conn",
  "EVENT_HUB_NAME=$EventHubName",
  "EVENT_HUB_CONSUMER_GROUP=$EventHubConsumerGroup",
  "AZDO_PAT=secretref:azdo-pat",
  "AZDO_ORG=$AzdoOrg",
  "AZDO_PROJECT=$AzdoProject",
  "AZDO_REPO=$AzdoRepo",
  "AZDO_REPO_CLONE_URL=$AzdoRepoCloneUrl",
  "MYRIDIUS_USE_OPENAI=1",
  "MYRIDIUS_OPENAI_API_KEY=secretref:myridius-openai-api-key",
  "MYRIDIUS_OPENAI_MODEL_ENDPOINT=$MyridiusOpenAiModelEndpoint",
  "MYRIDIUS_OPENAI_DEPLOYMENT_NAME=$MyridiusOpenAiDeploymentName",
  "OPENAI_API_KEY=secretref:myridius-openai-api-key",
  "OPENAI_BASE_URL=$MyridiusOpenAiModelEndpoint",
  "OPENAI_MODEL=$MyridiusOpenAiDeploymentName",
  "GIT_USERNAME=$GitUserName",
  "GIT_EMAIL=$GitEmail",
  "AI_PLANNING_STATUS_FIELD_REF_NAME=AIPlanningStatus",
  "AI_PLANNING_STATUS_REASON_FIELD_REF_NAME=AIPlanningStatusReason",
  "MYRIDIUS_CLI_AGENT=backend-specialist",
  "MYRIDIUS_CLI_FULL_AUTO=1",
  "MYRIDIUS_CLI_PERMISSION_MODE=",
  "MYRIDIUS_CLI_ALLOW_ROOT_BYPASS=1",
  "MYRIDIUS_CLI_DANGEROUSLY_SKIP_PERMISSIONS=0",
  "MYRIDIUS_CLI_STREAM_LINE_LOGS=1",
  "MYRIDIUS_CLI_COMMAND="
)

if ($containerAppExists) {
  az containerapp secret set --name $ContainerAppName --resource-group $ResourceGroup --secrets "eventhub-conn=$EventHubConnectionString" "azdo-pat=$AzdoPat" "myridius-openai-api-key=$MyridiusOpenAiApiKey" --only-show-errors | Out-Null
  az containerapp registry set --name $ContainerAppName --resource-group $ResourceGroup --server $acrServer --username $acrUser --password $acrPass --only-show-errors | Out-Null

  $revisionSuffix = (Get-Date -Format "yyyyMMdd-HHmmss")
  $updateArgs = @(
    "--name", $ContainerAppName,
    "--resource-group", $ResourceGroup,
    "--image", $image,
    "--cpu", "2",
    "--memory", "4Gi",
    "--min-replicas", "1",
    "--max-replicas", "1",
    "--revision-suffix", $revisionSuffix,
    "--set-env-vars"
  ) + $envVarsArgs + @("--only-show-errors")

  az containerapp update @updateArgs | Out-Null
} else {
  $createArgs = @(
  "--name", $ContainerAppName,
  "--resource-group", $ResourceGroup,
  "--environment", $ContainerAppEnvName,
  "--image", $image,
  "--registry-server", $acrServer,
  "--registry-username", $acrUser,
  "--registry-password", $acrPass,
  "--cpu", "2",
  "--memory", "4Gi",
  "--min-replicas", "1",
  "--max-replicas", "1",
  "--secrets", "eventhub-conn=$EventHubConnectionString", "azdo-pat=$AzdoPat", "myridius-openai-api-key=$MyridiusOpenAiApiKey",
  "--env-vars"
) + $envVarsArgs + @(
  "--only-show-errors"
)

  az containerapp create @createArgs | Out-Null
}

if ($LASTEXITCODE -ne 0) {
  throw "ACA deploy failed"
}

Write-Host "ACA worker deployed: $ContainerAppName" -ForegroundColor Green



