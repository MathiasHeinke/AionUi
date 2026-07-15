param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$collectionErrors = [System.Collections.Generic.List[string]]::new()

function Add-CollectionError {
  param([string]$Probe)
  if (-not $collectionErrors.Contains($Probe)) { $collectionErrors.Add($Probe) }
}

function Get-OptionalProperty {
  param([object]$InputObject, [string]$Name, [object]$Default = $null)
  if ($null -eq $InputObject) { return $Default }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Get-RegistryValue {
  param([string]$Path, [string]$Name)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return Get-ItemPropertyValue -LiteralPath $Path -Name $Name -ErrorAction Stop
  } catch [System.Management.Automation.PSArgumentException] {
    return $null
  } catch [System.Management.Automation.ItemNotFoundException] {
    return $null
  } catch {
    Add-CollectionError -Probe "registry:$Name"
    return $null
  }
}

function Convert-RegistrySwitch {
  param([object]$Value)
  if ($null -eq $Value) { return $null }
  try { return [int]$Value -eq 1 }
  catch { return $null }
}

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

$os = $null
$processors = @()
try { $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop }
catch { Add-CollectionError -Probe 'cim:operating-system' }
try { $processors = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop) }
catch { Add-CollectionError -Probe 'cim:processor' }

$identity = $null
$principal = $null
$isLocalAdministrator = $null
$tokenIsElevated = $null
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  $administratorSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $identityGroupSids = @($identity.Groups | ForEach-Object { $_.Value })
  $isLocalAdministrator = $identityGroupSids -contains $administratorSid.Value
  $tokenIsElevated = $principal.IsInRole($administratorSid)
} catch {
  Add-CollectionError -Probe 'identity:administrator-posture'
}

$uacPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$uacEnabled = Convert-RegistrySwitch -Value (Get-RegistryValue -Path $uacPath -Name 'EnableLUA')
$secureDesktopEnabled = Convert-RegistrySwitch -Value (Get-RegistryValue -Path $uacPath -Name 'PromptOnSecureDesktop')

$defenderStatus = $null
$defenderServiceRunning = $null
try { $defenderStatus = Get-MpComputerStatus -ErrorAction Stop }
catch { Add-CollectionError -Probe 'security:defender-status' }
try { $defenderServiceRunning = (Get-Service -Name WinDefend -ErrorAction Stop).Status -eq 'Running' }
catch { Add-CollectionError -Probe 'security:defender-service' }

$firewallByName = @{}
try {
  foreach ($profile in @(Get-NetFirewallProfile -ErrorAction Stop)) {
    $firewallByName[[string]$profile.Name] = [bool]$profile.Enabled
  }
} catch {
  Add-CollectionError -Probe 'security:firewall-profiles'
}

$smartScreenPolicyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'
$smartScreenShellPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer'
$smartScreenAppHostPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AppHost'
$processAuditPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\Audit'
$smartScreenPolicyEnabled = Convert-RegistrySwitch -Value (
  Get-RegistryValue -Path $smartScreenPolicyPath -Name 'EnableSmartScreen'
)
$smartScreenShellMode = Get-RegistryValue -Path $smartScreenPolicyPath -Name 'ShellSmartScreenLevel'
if ($null -eq $smartScreenShellMode) {
  $smartScreenShellMode = Get-RegistryValue -Path $smartScreenShellPath -Name 'SmartScreenEnabled'
}
$smartScreenAppReputationEnabled = Convert-RegistrySwitch -Value (
  Get-RegistryValue -Path $smartScreenAppHostPath -Name 'EnableWebContentEvaluation'
)
$processCommandLineAuditEnabled = Convert-RegistrySwitch -Value (
  Get-RegistryValue -Path $processAuditPath -Name 'ProcessCreationIncludeCmdLine_Enabled'
)

$nativeArchitecture = if (-not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
  $env:PROCESSOR_ARCHITEW6432
} else {
  $env:PROCESSOR_ARCHITECTURE
}

$facts = [ordered]@{
  schema_version = 'command-eve-windows-phase-b-machine-facts/v1'
  collected_at = [DateTimeOffset]::UtcNow.ToString('o')
  collection_errors = @($collectionErrors | Sort-Object -Unique)
  host = [ordered]@{
    os_caption = [string](Get-OptionalProperty -InputObject $os -Name 'Caption' -Default '')
    os_version = [string](Get-OptionalProperty -InputObject $os -Name 'Version' -Default '')
    os_build = [string](Get-OptionalProperty -InputObject $os -Name 'BuildNumber' -Default '')
    product_type = Get-OptionalProperty -InputObject $os -Name 'ProductType'
    native_architecture = [string]$nativeArchitecture
    process_architecture = [string]$env:PROCESSOR_ARCHITECTURE
    processor_architecture_codes = @($processors | ForEach-Object { [int]$_.Architecture })
    ram_bytes = Get-OptionalProperty -InputObject $os -Name 'TotalVisibleMemorySize' -Default $null
    logical_cpu_count = [int](@($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
  }
  user = [ordered]@{
    is_local_administrator = $isLocalAdministrator
    token_is_elevated = $tokenIsElevated
    uac_enabled = $uacEnabled
    secure_desktop_enabled = $secureDesktopEnabled
  }
  security = [ordered]@{
    defender_service_running = $defenderServiceRunning
    defender_antivirus_enabled = Get-OptionalProperty -InputObject $defenderStatus -Name 'AntivirusEnabled'
    defender_real_time_protection_enabled = Get-OptionalProperty -InputObject $defenderStatus -Name 'RealTimeProtectionEnabled'
    defender_behavior_monitor_enabled = Get-OptionalProperty -InputObject $defenderStatus -Name 'BehaviorMonitorEnabled'
    defender_ioav_protection_enabled = Get-OptionalProperty -InputObject $defenderStatus -Name 'IoavProtectionEnabled'
    defender_tamper_protected = Get-OptionalProperty -InputObject $defenderStatus -Name 'IsTamperProtected'
    smart_screen_policy_enabled = $smartScreenPolicyEnabled
    smart_screen_shell_mode = if ($null -eq $smartScreenShellMode) { $null } else { [string]$smartScreenShellMode }
    smart_screen_app_reputation_enabled = $smartScreenAppReputationEnabled
    process_creation_command_line_audit_enabled = $processCommandLineAuditEnabled
    firewall_domain_enabled = if ($firewallByName.ContainsKey('Domain')) { $firewallByName['Domain'] } else { $null }
    firewall_private_enabled = if ($firewallByName.ContainsKey('Private')) { $firewallByName['Private'] } else { $null }
    firewall_public_enabled = if ($firewallByName.ContainsKey('Public')) { $firewallByName['Public'] } else { $null }
  }
}

if ($null -ne $facts.host.ram_bytes) {
  $facts.host.ram_bytes = [int64]$facts.host.ram_bytes * 1024
}

Write-AtomicJson -Path $OutputPath -Value $facts
Write-Host "WIN_PHASE_B_MACHINE_FACTS_COMPLETE $OutputPath"
