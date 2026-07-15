param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [Parameter(Mandatory = $true)]
  [ValidateSet('lowmem-8gb', 'normal-16gb')]
  [string]$MemoryClass
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-AtomicJson {
  param([string]$Path, [object]$Value)
  $absolute = [System.IO.Path]::GetFullPath($Path)
  $directory = Split-Path -Parent $absolute
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = "$absolute.$PID.tmp"
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $absolute -Force
}

function Get-OptionalProperty {
  param([object]$InputObject, [string]$Name, [object]$Default = $null)
  if ($null -eq $InputObject) { return $Default }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

$eventPayload = $null
if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_EVENT_PATH) -and (Test-Path -LiteralPath $env:GITHUB_EVENT_PATH -PathType Leaf)) {
  try {
    $eventPayload = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $eventPayload = $null
  }
}
$eventRepository = Get-OptionalProperty -InputObject $eventPayload -Name 'repository'
$eventInputs = Get-OptionalProperty -InputObject $eventPayload -Name 'inputs'
$repositoryFullName = [string](Get-OptionalProperty -InputObject $eventRepository -Name 'full_name' -Default '')
$repositoryPrivate = Get-OptionalProperty -InputObject $eventRepository -Name 'private'
$repositoryVisibility = if ($repositoryPrivate -eq $true) {
  'private'
} elseif ($repositoryPrivate -eq $false) {
  'public'
} else {
  'unknown'
}
$requestedCommit = [string](Get-OptionalProperty -InputObject $eventInputs -Name 'source_commit' -Default '')

$controllerTokenPresent =
  -not [string]::IsNullOrWhiteSpace($env:GH_TOKEN) -or
  -not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN) -or
  -not [string]::IsNullOrWhiteSpace($env:GITHUB_PAT) -or
  -not [string]::IsNullOrWhiteSpace($env:GH_ENTERPRISE_TOKEN)
$productionSecretNames = @(
  'AIONUI_IMG_API_KEY',
  'ANTHROPIC_API_KEY',
  'APPLE_ID_PASSWORD',
  'APP_PRIVATE_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'CLOUDFLARE_API_TOKEN',
  'COMMAND_EVE_KANBAN_ACP_BEARER_FILE',
  'COMMAND_EVE_PHASE_A_LICENSE',
  'COMMAND_EVE_TEAM_MANAGE_BEARER_FILE',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'SENTRY_AUTH_TOKEN',
  'STRIPE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'XAI_API_KEY'
)
$productionSecretsAvailable = @(
  foreach ($name in $productionSecretNames) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($value)) { $name }
  }
).Count -gt 0
$memoryLabel = if ($MemoryClass -eq 'lowmem-8gb') { 'phase-b-lowmem' } else { 'phase-b-normal' }
$eventName = [string]$env:GITHUB_EVENT_NAME
$triggerCommit = [string]$env:GITHUB_SHA

$policy = [ordered]@{
  schema_version = 'command-eve-windows-phase-b-runner-policy/v1'
  repository = [ordered]@{
    full_name = $repositoryFullName
    visibility = $repositoryVisibility
  }
  dispatch = [ordered]@{
    event_name = $eventName
    requested_commit = $requestedCommit
    trigger_commit = $triggerCommit
    pull_request_from_fork = $eventName -ne 'workflow_dispatch'
    permissions = [ordered]@{
      contents = 'read'
      actions = 'none'
      checks = 'none'
      deployments = 'none'
      id_token = 'none'
      packages = 'none'
    }
  }
  runner = [ordered]@{
    mode = if ($env:COMMAND_EVE_PHASE_B_JIT -eq '1') { 'jit' } else { 'unknown' }
    max_jobs = if ($env:COMMAND_EVE_PHASE_B_JIT -eq '1') { 1 } else { 0 }
    labels = @('self-hosted', 'Windows', 'X64', 'command-eve-phase-b', $memoryLabel)
    work_folder = '_work'
    preexisting_credential_file_count = if (
      $env:COMMAND_EVE_PREEXISTING_CREDENTIAL_FILE_COUNT -match '^[0-9]+$'
    ) {
      [int]$env:COMMAND_EVE_PREEXISTING_CREDENTIAL_FILE_COUNT
    } else {
      -1
    }
    controller_token_present = $controllerTokenPresent
    production_secrets_available = $productionSecretsAvailable
    root_is_disposable = $env:COMMAND_EVE_RUNNER_ROOT_DISPOSABLE -eq '1'
    diagnostics_externalized = $env:COMMAND_EVE_RUNNER_DIAGNOSTICS_EXTERNALIZED -eq '1'
    credential_delivery = if ($env:COMMAND_EVE_PHASE_B_JIT -eq '1') {
      'encoded_jit_config_once'
    } else {
      'persistent_registration_token'
    }
  }
}

Write-AtomicJson -Path $OutputPath -Value $policy
Write-Host "WIN_PHASE_B_RUNNER_POLICY_FACTS_COMPLETE $OutputPath"
