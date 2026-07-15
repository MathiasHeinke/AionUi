param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$GateDirectory = 'reports/windows/phase-a/gates',
  [string]$EvidenceDirectory = 'reports/windows/phase-a/runtime',
  [int]$BootstrapTimeoutSeconds = 2400,
  [int]$RestartBootstrapTimeoutSeconds = 600,
  [int]$TurnTimeoutSeconds = 600,
  [int]$CreditProbeTimeoutSeconds = 300,
  [int]$StreamDrainTimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-AtomicJson {
  param([string]$Path, [object]$Value)
  $absolute = [System.IO.Path]::GetFullPath($Path)
  $directory = Split-Path -Parent $absolute
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = "$absolute.$PID.tmp"
  $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $temporary -Encoding utf8NoBOM
  Move-Item -LiteralPath $temporary -Destination $absolute -Force
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { return $null }
}

function Get-OptionalProperty {
  param([object]$InputObject, [string]$Name, [object]$Default = $null)
  if ($null -eq $InputObject) { return $Default }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function New-ProcessStartInfo {
  param(
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$RawArguments = '',
    [hashtable]$Environment = @{},
    [string]$WorkingDirectory = ''
  )
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $FilePath
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $info.WorkingDirectory = $WorkingDirectory }
  if (-not [string]::IsNullOrEmpty($RawArguments)) {
    if (@($Arguments).Count -gt 0) { throw 'Arguments and RawArguments are mutually exclusive.' }
    $info.Arguments = $RawArguments
  } else {
    foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  }
  foreach ($key in $Environment.Keys) { $info.Environment[$key] = [string]$Environment[$key] }
  return $info
}

function Wait-ForCapturedStreams {
  param(
    [System.Threading.Tasks.Task[string]]$StdoutTask,
    [System.Threading.Tasks.Task[string]]$StderrTask,
    [int]$TimeoutSeconds = 30
  )
  $drained = $false
  try {
    $tasks = [System.Threading.Tasks.Task[]]@($StdoutTask, $StderrTask)
    $drained = [System.Threading.Tasks.Task]::WaitAll($tasks, ([Math]::Max(1, $TimeoutSeconds) * 1000))
  } catch {}
  $stdout = if ($StdoutTask.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) { $StdoutTask.Result } else { '' }
  $stderr = if ($StderrTask.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) { $StderrTask.Result } else { '' }
  if (-not $drained) {
    $stderr = @($stderr, "[phase-a] captured stream drain timed out after ${TimeoutSeconds}s") -join [Environment]::NewLine
  }
  return [pscustomobject]@{ Drained = $drained; Stdout = $stdout; Stderr = $stderr }
}

function Invoke-CapturedProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$RawArguments = '',
    [int]$TimeoutSeconds = 300,
    [hashtable]$Environment = @{},
    [string]$WorkingDirectory = '',
    [string]$HeartbeatLabel = ''
  )
  $started = [DateTimeOffset]::UtcNow
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = New-ProcessStartInfo -FilePath $FilePath -Arguments $Arguments -RawArguments $RawArguments -Environment $Environment -WorkingDirectory $WorkingDirectory
  if (-not $process.Start()) { throw "Unable to start $FilePath" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $nextHeartbeat = [DateTimeOffset]::UtcNow.AddSeconds(30)
  while (-not $process.HasExited -and [DateTimeOffset]::UtcNow -lt $deadline) {
    [void]$process.WaitForExit(1000)
    if (-not $process.HasExited -and [DateTimeOffset]::UtcNow -ge $nextHeartbeat) {
      $elapsed = [int]([DateTimeOffset]::UtcNow - $started).TotalSeconds
      $label = if ([string]::IsNullOrWhiteSpace($HeartbeatLabel)) { [System.IO.Path]::GetFileName($FilePath) } else { $HeartbeatLabel }
      Write-Host "[phase-a] $label heartbeat: ${elapsed}s elapsed"
      $nextHeartbeat = [DateTimeOffset]::UtcNow.AddSeconds(30)
    }
  }
  $exited = $process.HasExited
  if (-not $exited) {
    try { $process.Kill($true) } catch {}
    [void]$process.WaitForExit(30000)
  } else {
    $process.WaitForExit()
  }
  $streams = Wait-ForCapturedStreams -StdoutTask $stdoutTask -StderrTask $stderrTask -TimeoutSeconds $StreamDrainTimeoutSeconds
  $stdout = $streams.Stdout
  $stderr = $streams.Stderr
  $completed = [DateTimeOffset]::UtcNow
  return [pscustomobject]@{
    ExitCode = if ($exited) { $process.ExitCode } else { 124 }
    TimedOut = -not $exited
    Stdout = $stdout
    Stderr = $stderr
    DurationMs = [int64]($completed - $started).TotalMilliseconds
  }
}

function Get-DescendantProcessIds {
  param([int]$RootPid)
  if ($RootPid -le 0) { return @() }
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    foreach ($child in $all | Where-Object { [int]$_.ParentProcessId -eq $parent }) {
      $childPid = [int]$child.ProcessId
      if ($seen.Add($childPid)) { $queue.Enqueue($childPid) }
    }
  }
  return @($seen | Sort-Object)
}

function Get-ProfileScopedProcessIds {
  param([string]$ProfilePath)
  $needle = [System.IO.Path]::GetFullPath($ProfilePath)
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($needle, [System.StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { [int]$_.ProcessId } |
      Sort-Object -Unique
  )
}

function Get-CommandLineScopedProcessIds {
  param([string[]]$Needles)
  $normalizedNeedles = @($Needles | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($normalizedNeedles.Count -eq 0) { return @() }
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
        foreach ($needle in $normalizedNeedles) {
          if ($commandLine.Contains($needle, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
      } |
      ForEach-Object { [int]$_.ProcessId } |
      Sort-Object -Unique
  )
}

function Stop-OwnedProcessTree {
  param([int]$RootPid, [string]$ProfilePath)
  $owned = @()
  if ($RootPid -gt 0) { $owned += $RootPid; $owned += Get-DescendantProcessIds -RootPid $RootPid }
  $owned += Get-ProfileScopedProcessIds -ProfilePath $ProfilePath
  $owned = @($owned | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  if ($RootPid -gt 0) {
    & taskkill.exe /PID $RootPid /T /F 2>&1 | Out-Null
  }
  foreach ($ownedPid in $owned) {
    Stop-Process -Id $ownedPid -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  return @($owned | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
}

function Test-AionCoreObserved {
  param([string]$ProfilePath)
  $needle = [System.IO.Path]::GetFullPath($ProfilePath)
  return [bool](
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -match '^aioncore(?:\.exe)?$' -and
        $_.CommandLine -and
        $_.CommandLine.Contains($needle, [System.StringComparison]::OrdinalIgnoreCase)
      } |
      Select-Object -First 1
  )
}

function Wait-ForAionCore {
  param([string]$ProfilePath, [int]$TimeoutSeconds = 90)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-AionCoreObserved -ProfilePath $ProfilePath) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Wait-ForRuntimeReceipt {
  param(
    [string]$ReceiptPath,
    [int]$TimeoutSeconds,
    [DateTimeOffset]$StartedAfter = [DateTimeOffset]::MinValue
  )
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $nextHeartbeat = [DateTimeOffset]::UtcNow
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $receipt = Read-JsonFile -Path $ReceiptPath
    $status = [string](Get-OptionalProperty -InputObject $receipt -Name 'status' -Default '')
    $receiptStartedAtText = [string](Get-OptionalProperty -InputObject $receipt -Name 'started_at' -Default '')
    $receiptStartedAt = [DateTimeOffset]::MinValue
    $fresh = $StartedAfter -eq [DateTimeOffset]::MinValue
    if (-not $fresh -and [DateTimeOffset]::TryParse($receiptStartedAtText, [ref]$receiptStartedAt)) {
      $fresh = $receiptStartedAt -gt $StartedAfter
    }
    $terminalFailure = $status -in @('blocked', 'failed', 'skipped')
    $terminalReady = $status -eq 'ready' -and (Get-StageStatus -Receipt $receipt -StageId 'model') -ne 'missing'
    if ($receipt -and $fresh -and ($terminalFailure -or $terminalReady)) { return $receipt }
    if ([DateTimeOffset]::UtcNow -ge $nextHeartbeat) {
      $elapsed = $TimeoutSeconds - [int]($deadline - [DateTimeOffset]::UtcNow).TotalSeconds
      Write-Host "[phase-a] Runtime bootstrap heartbeat: ${elapsed}s elapsed"
      $nextHeartbeat = [DateTimeOffset]::UtcNow.AddSeconds(30)
    }
    Start-Sleep -Seconds 2
  }
  return $null
}

function Get-StageStatus {
  param([object]$Receipt, [string]$StageId)
  $stages = Get-OptionalProperty -InputObject $Receipt -Name 'stages'
  if ($null -eq $stages) { return 'missing' }
  $stage = @($stages | Where-Object { (Get-OptionalProperty -InputObject $_ -Name 'id') -eq $StageId } | Select-Object -First 1)
  if ($stage.Count -eq 1) { return [string](Get-OptionalProperty -InputObject $stage[0] -Name 'status' -Default 'missing') }
  return 'missing'
}

function Get-CreditDeltaObserved {
  param([object]$Before, [object]$After)
  if (-not $Before -or -not $After -or (Get-OptionalProperty $Before 'ok') -ne $true -or (Get-OptionalProperty $After 'ok') -ne $true) { return $false }
  $beforeTier = [string](Get-OptionalProperty $Before 'tier' '')
  $afterTier = [string](Get-OptionalProperty $After 'tier' '')
  if ($beforeTier -cne $afterTier) { return $false }
  if ($beforeTier -ceq 'free' -and [double](Get-OptionalProperty $Before 'purchased_credits_remaining' 0) -le 0) { return $false }
  if ([string](Get-OptionalProperty $Before 'period_start' '') -ne [string](Get-OptionalProperty $After 'period_start' '')) { return $false }
  return (
    [double](Get-OptionalProperty $After 'included_allowance_credits_remaining' 0) -lt [double](Get-OptionalProperty $Before 'included_allowance_credits_remaining' 0) -or
    [double](Get-OptionalProperty $After 'purchased_credits_remaining' 0) -lt [double](Get-OptionalProperty $Before 'purchased_credits_remaining' 0)
  )
}

function Get-ProviderSecretFindingCount {
  param([string[]]$Roots)
  $pattern = '(?i)\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b'
  $textExtensions = @('', '.cfg', '.conf', '.csv', '.env', '.ini', '.json', '.jsonl', '.log', '.md', '.toml', '.txt', '.xml', '.yaml', '.yml')
  $count = 0
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue) {
      $isDotEnv = $file.Name -ieq '.env' -or $file.Name.StartsWith('.env.', [System.StringComparison]::OrdinalIgnoreCase)
      if ($file.Length -gt 5MB -or (-not $isDotEnv -and $file.Extension.ToLowerInvariant() -notin $textExtensions)) { continue }
      try { $count += ([regex]::Matches((Get-Content -LiteralPath $file.FullName -Raw), $pattern)).Count }
      catch {}
    }
  }
  return $count
}

function Get-ExactTextFindingCount {
  param([string[]]$Roots, [string]$Needle)
  if ([string]::IsNullOrEmpty($Needle)) { return 0 }
  $textExtensions = @('', '.cfg', '.conf', '.csv', '.env', '.ini', '.json', '.jsonl', '.log', '.md', '.toml', '.txt', '.xml', '.yaml', '.yml')
  $count = 0
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue) {
      $isDotEnv = $file.Name -ieq '.env' -or $file.Name.StartsWith('.env.', [System.StringComparison]::OrdinalIgnoreCase)
      if ($file.Length -gt 5MB -or (-not $isDotEnv -and $file.Extension.ToLowerInvariant() -notin $textExtensions)) { continue }
      try {
        $content = Get-Content -LiteralPath $file.FullName -Raw
        if ($content.Contains($Needle, [System.StringComparison]::Ordinal)) { $count += 1 }
      } catch {}
    }
  }
  return $count
}

function Get-RegistryResidueCount {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $count = 0
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction Stop) {
      $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      $displayName = [string](Get-OptionalProperty -InputObject $properties -Name 'DisplayName' -Default '')
      if ($displayName -like 'Command EVE*') { $count += 1 }
    }
  }
  return $count
}

$startedAt = [DateTimeOffset]::UtcNow
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repositoryRoot
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$gateRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $GateDirectory))
$evidenceRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $EvidenceDirectory))
New-Item -ItemType Directory -Path $gateRoot, $evidenceRoot -Force | Out-Null

$runSuffix = if ($env:GITHUB_RUN_ID) { "$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" } else { [guid]::NewGuid().ToString('N') }
$profileRoot = Join-Path $env:RUNNER_TEMP "command-eve-phase-a-$runSuffix"
$dataPath = Join-Path $profileRoot 'command-eve'
$hermesTurnWorkingDirectory = Join-Path $profileRoot 'hermes-turn-cwd'
$runtimeRoot = Join-Path $dataPath 'command-eve-runtime'
$runtimeReceiptPath = Join-Path $runtimeRoot 'runtime-bootstrap-receipt.json'
$promptProofPath = Join-Path $runtimeRoot 'last-prompt-proof.json'
$egressReceiptPath = Join-Path $runtimeRoot 'last-egress-boundary-receipt.json'
$tokenPath = Join-Path $runtimeRoot 'shim-auth-token'

$seatProvisionEvidence = Join-Path $evidenceRoot 'seat-provision.json'
$licenseWireEvidence = Join-Path $evidenceRoot 'license-wire-proof.json'
$creditsBeforeEvidence = Join-Path $evidenceRoot 'credits-before.json'
$creditsAfterEvidence = Join-Path $evidenceRoot 'credits-after.json'
$runtimeEvidence = Join-Path $evidenceRoot 'runtime-bootstrap-receipt.json'
$firstRuntimeEvidence = Join-Path $evidenceRoot 'runtime-bootstrap-first-launch-receipt.json'
$restartRuntimeEvidence = Join-Path $evidenceRoot 'runtime-bootstrap-restart-receipt.json'
$promptEvidence = Join-Path $evidenceRoot 'prompt-proof.json'
$egressEvidence = Join-Path $evidenceRoot 'egress-boundary-receipt.json'
$rawEvidencePath = Join-Path $evidenceRoot 'phase-a-raw-evidence.json'

$commands = [System.Collections.Generic.List[object]]::new()
$fatalErrors = [System.Collections.Generic.List[string]]::new()
$appPath = ''
$installDirectory = ''
$uninstallerPath = ''
$firstRootPid = 0
$restartRootPid = 0
$firstSurvivors = @()
$restartSurvivors = @()
$cancelSurvivors = @()
$installExitCode = -1
$uninstallExitCode = -1
$firstAionCore = $false
$restartAionCore = $false
$runtimeReceipt = $null
$restartRuntimeReceipt = $null
$firstTurn = $null
$restartTurn = $null
$promptProof = $null
$egressReceipt = $null
$creditsBefore = $null
$creditsAfter = $null
$seatProvision = $null
$licenseWireProof = $null
$cancelRequested = $false
$shortcutFoundBeforeUninstall = $false
$hermesExecutableFound = $false
$versionProbeExitCode = -1
$versionProbeOutput = ''
$phaseALicense = [string]$env:COMMAND_EVE_PHASE_A_LICENSE
$credentialAvailable = -not [string]::IsNullOrWhiteSpace($phaseALicense)
$credentialEnvironment = if ($credentialAvailable) { @{ COMMAND_EVE_PHASE_A_LICENSE = $phaseALicense } } else { @{} }
Remove-Item Env:COMMAND_EVE_PHASE_A_LICENSE -ErrorAction SilentlyContinue

$env:AIONUI_E2E_TEST = '1'
$env:AIONUI_DISABLE_AUTO_UPDATE = '1'
$env:COMMAND_EVE_REGISTRATION_REQUIRED = '1'
$env:CI = 'true'
New-Item -ItemType Directory -Path $profileRoot, $hermesTurnWorkingDirectory -Force | Out-Null

try {
  if ((Get-AuthenticodeSignature -LiteralPath $installer).Status -ne 'NotSigned') {
    throw 'Phase A candidate must be unsigned.'
  }

  $install = Invoke-CapturedProcess -FilePath $installer -Arguments @('/S') -TimeoutSeconds 300
  $installExitCode = $install.ExitCode
  $commands.Add([ordered]@{ command = 'nsis-installer /S'; exit_code = $install.ExitCode; duration_ms = $install.DurationMs })

  $programRoots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Command EVE'),
    (Join-Path $env:ProgramFiles 'Command EVE'),
    (Join-Path ${env:ProgramFiles(x86)} 'Command EVE')
  ) | Where-Object { $_ }
  foreach ($root in $programRoots) {
    $candidate = Join-Path $root 'Command EVE.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $appPath = $candidate; break }
  }
  if (-not $appPath) {
    $fallbackAppPath = @(
      Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'Command EVE.exe' -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName -First 1
    )
    if ($fallbackAppPath.Count -gt 0) { $appPath = [string]$fallbackAppPath[0] }
  }
  if ($appPath) {
    $installDirectory = Split-Path -Parent $appPath
    $uninstallerCandidates = @(
      Get-ChildItem -LiteralPath $installDirectory -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName -First 1
    )
    if ($uninstallerCandidates.Count -gt 0) { $uninstallerPath = [string]$uninstallerCandidates[0] }
  }

  $desktopShortcutBefore = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Command EVE.lnk'
  $startMenuProgramsBefore = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $startMenuShortcutBefore = @(
    Get-ChildItem -LiteralPath $startMenuProgramsBefore -Filter 'Command EVE.lnk' -Recurse -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
  )
  $shortcutFoundBeforeUninstall =
    (Test-Path -LiteralPath $desktopShortcutBefore) -or $startMenuShortcutBefore.Count -gt 0

  if ($credentialAvailable) {
    $provision = Invoke-CapturedProcess -FilePath 'bun' -Arguments @(
      'x', 'tsx', 'scripts/windows/provisionPhaseATestSeat.ts', '--data', $dataPath, '--out', $seatProvisionEvidence
    ) -TimeoutSeconds 60 -Environment $credentialEnvironment
    $commands.Add([ordered]@{ command = 'provision dedicated Phase A test seat'; exit_code = $provision.ExitCode; duration_ms = $provision.DurationMs })
    $seatProvision = Read-JsonFile -Path $seatProvisionEvidence

    $electron = Join-Path $repositoryRoot 'node_modules\electron\dist\electron.exe'
    $seed = Invoke-CapturedProcess -FilePath $electron -Arguments @(
      'scripts/windows/seedPhaseALicense.cjs', '--data', $dataPath, '--out', $licenseWireEvidence
    ) -TimeoutSeconds 60 -Environment $credentialEnvironment
    $commands.Add([ordered]@{ command = 'seed test seat license via Electron safeStorage'; exit_code = $seed.ExitCode; duration_ms = $seed.DurationMs })
    $licenseWireProof = Read-JsonFile -Path $licenseWireEvidence

    $creditProbe = Invoke-CapturedProcess -FilePath 'node' -Arguments @(
      'scripts/windows/probePhaseACredits.mjs', '--out', $creditsBeforeEvidence
    ) -TimeoutSeconds 60 -Environment $credentialEnvironment
    $commands.Add([ordered]@{ command = 'credits-status before cloud turn'; exit_code = $creditProbe.ExitCode; duration_ms = $creditProbe.DurationMs })
    $creditsBefore = Read-JsonFile -Path $creditsBeforeEvidence
  }

  if (-not $appPath) { throw 'Installed Command EVE executable was not found.' }
  $firstProcess = Start-Process -FilePath $appPath -ArgumentList @("--user-data-dir=$profileRoot") -PassThru
  $firstRootPid = $firstProcess.Id
  $commands.Add([ordered]@{ command = 'installed Command EVE first launch'; exit_code = 0 })
  $runtimeReceipt = Wait-ForRuntimeReceipt -ReceiptPath $runtimeReceiptPath -TimeoutSeconds $BootstrapTimeoutSeconds
  $firstAionCore = Wait-ForAionCore -ProfilePath $profileRoot -TimeoutSeconds 90
  if ($runtimeReceipt) {
    Copy-Item -LiteralPath $runtimeReceiptPath -Destination $firstRuntimeEvidence -Force
    Copy-Item -LiteralPath $runtimeReceiptPath -Destination $runtimeEvidence -Force
  }

  if ($runtimeReceipt -and (Get-OptionalProperty $runtimeReceipt 'status') -eq 'ready') {
    $hermesPath = Join-Path $dataPath 'command-eve-runtime\hermes\venv\Scripts\hermes.exe'
    $hermesPythonPath = Join-Path (Split-Path -Parent $hermesPath) 'python.exe'
    $hermesExecutableFound = Test-Path -LiteralPath $hermesPath -PathType Leaf
    $runtimeHermesHome = [string](Get-OptionalProperty $runtimeReceipt 'hermes_home' '')
    $env:HERMES_HOME = $runtimeHermesHome
    $env:COMMAND_EVE_SHIM_AUTH_TOKEN_FILE = $tokenPath
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $env:Path = "$(Split-Path -Parent $hermesPath);$env:Path"

    $versionProbe = Invoke-CapturedProcess -FilePath $hermesPythonPath -Arguments @(
      '-c', "from importlib.metadata import version; print(version('hermes-agent'))"
    ) -TimeoutSeconds 60 -WorkingDirectory $hermesTurnWorkingDirectory -HeartbeatLabel 'managed Hermes metadata probe'
    $versionProbeExitCode = $versionProbe.ExitCode
    $versionProbeOutput = $versionProbe.Stdout.Trim()
    $commands.Add([ordered]@{ command = 'managed Hermes version probe'; exit_code = $versionProbe.ExitCode; duration_ms = $versionProbe.DurationMs })

    $firstTurn = Invoke-CapturedProcess -FilePath $hermesPath -Arguments @(
      '-z', 'Reply with exactly WINDOWS_X64_CLOUD_CHAT_OK and no other text.'
    ) -TimeoutSeconds $TurnTimeoutSeconds -WorkingDirectory $hermesTurnWorkingDirectory -HeartbeatLabel 'Hermes managed cloud one-shot'
    $commands.Add([ordered]@{ command = 'Hermes managed cloud one-shot'; exit_code = $firstTurn.ExitCode; duration_ms = $firstTurn.DurationMs })
    $promptProof = Read-JsonFile -Path $promptProofPath
    $egressReceipt = Read-JsonFile -Path $egressReceiptPath
    if ($promptProof) { Copy-Item -LiteralPath $promptProofPath -Destination $promptEvidence -Force }
    if ($egressReceipt) { Copy-Item -LiteralPath $egressReceiptPath -Destination $egressEvidence -Force }

    $cancelInfo = New-ProcessStartInfo -FilePath $hermesPath -Arguments @(
      '-z', 'Prepare a very long detailed Windows deployment analysis with at least 5000 words.'
    ) -WorkingDirectory $hermesTurnWorkingDirectory
    $cancelProcess = [System.Diagnostics.Process]::new()
    $cancelProcess.StartInfo = $cancelInfo
    if ($cancelProcess.Start()) {
      $cancelStdout = $cancelProcess.StandardOutput.ReadToEndAsync()
      $cancelStderr = $cancelProcess.StandardError.ReadToEndAsync()
      Start-Sleep -Seconds 3
      $cancelRequested = -not $cancelProcess.HasExited
      $cancelOwned = @($cancelProcess.Id) + @(Get-DescendantProcessIds -RootPid $cancelProcess.Id)
      if ($cancelRequested) {
        try { $cancelProcess.Kill($true) } catch {}
        [void]$cancelProcess.WaitForExit(30000)
      }
      $cancelStreams = Wait-ForCapturedStreams -StdoutTask $cancelStdout -StderrTask $cancelStderr -TimeoutSeconds $StreamDrainTimeoutSeconds
      if (-not $cancelStreams.Drained) { $fatalErrors.Add('Cancel process stream drain timed out.') }
      Start-Sleep -Seconds 1
      $cancelScoped = Get-CommandLineScopedProcessIds -Needles @($hermesPath, $runtimeHermesHome)
      $cancelSurvivors = @(
        @($cancelOwned) + @($cancelScoped) |
          Sort-Object -Unique |
          Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
      )
      $commands.Add([ordered]@{ command = 'cancel owned Hermes process tree'; exit_code = if ($cancelSurvivors.Count -eq 0) { 0 } else { 1 } })
    }
  }
} catch {
  $fatalErrors.Add($_.Exception.Message)
} finally {
  $firstSurvivors = Stop-OwnedProcessTree -RootPid $firstRootPid -ProfilePath $profileRoot
}

try {
  if ($appPath -and (Test-Path -LiteralPath $appPath)) {
    $restartStartedAt = [DateTimeOffset]::UtcNow
    $restartProcess = Start-Process -FilePath $appPath -ArgumentList @("--user-data-dir=$profileRoot") -PassThru
    $restartRootPid = $restartProcess.Id
    $commands.Add([ordered]@{ command = 'installed Command EVE restart'; exit_code = 0 })
    $restartAionCore = Wait-ForAionCore -ProfilePath $profileRoot -TimeoutSeconds 90
    $restartRuntimeReceipt = Wait-ForRuntimeReceipt -ReceiptPath $runtimeReceiptPath -TimeoutSeconds $RestartBootstrapTimeoutSeconds -StartedAfter $restartStartedAt
    if ($restartRuntimeReceipt) {
      Copy-Item -LiteralPath $runtimeReceiptPath -Destination $restartRuntimeEvidence -Force
      Copy-Item -LiteralPath $runtimeReceiptPath -Destination $runtimeEvidence -Force
    }
    if ($restartRuntimeReceipt -and (Get-OptionalProperty $restartRuntimeReceipt 'status') -eq 'ready') {
      $hermesPath = Join-Path $dataPath 'command-eve-runtime\hermes\venv\Scripts\hermes.exe'
      $env:HERMES_HOME = [string](Get-OptionalProperty $restartRuntimeReceipt 'hermes_home' '')
      $env:COMMAND_EVE_SHIM_AUTH_TOKEN_FILE = $tokenPath
      $restartTurn = Invoke-CapturedProcess -FilePath $hermesPath -Arguments @(
        '-z', 'Reply with exactly WINDOWS_X64_RESTART_OK and no other text.'
      ) -TimeoutSeconds $TurnTimeoutSeconds -WorkingDirectory $hermesTurnWorkingDirectory -HeartbeatLabel 'Hermes post-cancel restart one-shot'
      $commands.Add([ordered]@{ command = 'Hermes post-cancel restart one-shot'; exit_code = $restartTurn.ExitCode; duration_ms = $restartTurn.DurationMs })
    }
  }
} catch {
  $fatalErrors.Add($_.Exception.Message)
} finally {
  $restartSurvivors = Stop-OwnedProcessTree -RootPid $restartRootPid -ProfilePath $profileRoot
}

try {
  if ($credentialAvailable) {
    $creditDeadline = [DateTimeOffset]::UtcNow.AddSeconds($CreditProbeTimeoutSeconds)
    do {
      $probe = Invoke-CapturedProcess -FilePath 'node' -Arguments @(
        'scripts/windows/probePhaseACredits.mjs', '--out', $creditsAfterEvidence
      ) -TimeoutSeconds 60 -Environment $credentialEnvironment
      $creditsAfter = Read-JsonFile -Path $creditsAfterEvidence
      if (Get-CreditDeltaObserved -Before $creditsBefore -After $creditsAfter) { break }
      if ([DateTimeOffset]::UtcNow -lt $creditDeadline) { Start-Sleep -Seconds 5 }
    } while ([DateTimeOffset]::UtcNow -lt $creditDeadline)
    $commands.Add([ordered]@{ command = 'credits-status after cloud turn'; exit_code = $probe.ExitCode; duration_ms = $probe.DurationMs })
  }
} catch {
  $fatalErrors.Add($_.Exception.Message)
}

try {
  if ($uninstallerPath -and (Test-Path -LiteralPath $uninstallerPath)) {
    $temporaryUninstaller = Join-Path $env:RUNNER_TEMP "command-eve-uninstall-$runSuffix.exe"
    Copy-Item -LiteralPath $uninstallerPath -Destination $temporaryUninstaller -Force
    try {
      if ($installDirectory.Contains('"', [System.StringComparison]::Ordinal)) {
        throw 'NSIS install directory contains an unsupported quote character.'
      }
      $uninstall = Invoke-CapturedProcess -FilePath $temporaryUninstaller -RawArguments "/S _?=$installDirectory" -TimeoutSeconds 300 -HeartbeatLabel 'Command EVE NSIS uninstall'
      $uninstallExitCode = $uninstall.ExitCode
      $commands.Add([ordered]@{ command = 'copied Command EVE uninstaller /S'; exit_code = $uninstall.ExitCode; duration_ms = $uninstall.DurationMs })
    } finally {
      Remove-Item -LiteralPath $temporaryUninstaller -Force -ErrorAction SilentlyContinue
    }
  }
} catch {
  $fatalErrors.Add($_.Exception.Message)
}
Start-Sleep -Seconds 5

$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Command EVE.lnk'
$startMenuPrograms = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$startMenuShortcuts = @(
  Get-ChildItem -LiteralPath $startMenuPrograms -Filter 'Command EVE.lnk' -Recurse -File -ErrorAction SilentlyContinue
)
$processResidue = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(?:Command EVE|aioncore)(?:\.exe)?$' } |
    ForEach-Object { [int]$_.ProcessId }
)
$installResidueCount = if ($installDirectory -and (Test-Path -LiteralPath $installDirectory)) { 1 } else { 0 }
$desktopShortcutResidueCount = if (Test-Path -LiteralPath $desktopShortcut) { 1 } else { 0 }
$shortcutResidueCount = $desktopShortcutResidueCount + $startMenuShortcuts.Count
$registryResidueCount = Get-RegistryResidueCount
$providerSecretFindingCount = Get-ProviderSecretFindingCount -Roots @($profileRoot, $evidenceRoot)
$plaintextTestSeatFindingCount = Get-ExactTextFindingCount -Roots @($profileRoot, $evidenceRoot) -Needle $phaseALicense
$phaseALicense = $null
$credentialEnvironment = @{}

try { Remove-Item -LiteralPath $profileRoot -Recurse -Force -ErrorAction Stop } catch { $fatalErrors.Add($_.Exception.Message) }
$profileRemoved = -not (Test-Path -LiteralPath $profileRoot)

$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$evidenceRuntimeReceipt = if ($restartRuntimeReceipt) { $restartRuntimeReceipt } else { $runtimeReceipt }
$runtimeProvenance = Get-OptionalProperty -InputObject $evidenceRuntimeReceipt -Name 'runtime_provenance'
$runtimeHermes = Get-OptionalProperty -InputObject $runtimeProvenance -Name 'hermes'
$runtimePython = Get-OptionalProperty -InputObject $runtimeProvenance -Name 'python'
$egressProvider = Get-OptionalProperty -InputObject $egressReceipt -Name 'provider'
$hermesExecutablePath = Join-Path $dataPath 'command-eve-runtime\hermes\venv\Scripts\hermes.exe'
$firstTurnOutput = if ($firstTurn) { [string]$firstTurn.Stdout } else { '' }
$restartTurnOutput = if ($restartTurn) { [string]$restartTurn.Stdout } else { '' }

$rawEvidence = [ordered]@{
  artifact_path = $installer
  environment = [ordered]@{
    os = [string]$os.Caption
    os_build = [string]$os.BuildNumber
    arch = 'x64'
    ram_bytes = [int64]$computer.TotalPhysicalMemory
    cpu_count = [int][Environment]::ProcessorCount
    test_mode = 'packaged-nsis-phase-a'
  }
  commands = @($commands)
  started_at = $startedAt.ToString('o')
  completed_at = [DateTimeOffset]::UtcNow.ToString('o')
  evidence_paths = @(
    'reports/windows/phase-a/runtime/phase-a-raw-evidence.json',
    'reports/windows/phase-a/runtime/runtime-bootstrap-receipt.json',
    'reports/windows/phase-a/runtime/runtime-bootstrap-first-launch-receipt.json',
    'reports/windows/phase-a/runtime/runtime-bootstrap-restart-receipt.json',
    'reports/windows/phase-a/runtime/prompt-proof.json',
    'reports/windows/phase-a/runtime/egress-boundary-receipt.json',
    'reports/windows/phase-a/runtime/credits-before.json',
    'reports/windows/phase-a/runtime/credits-after.json',
    'reports/windows/phase-a/runtime/seat-provision.json',
    'reports/windows/phase-a/runtime/license-wire-proof.json'
  )
  install = [ordered]@{
    exit_code = $installExitCode
    app_executable_found = [bool]($appPath -and $installDirectory)
    uninstaller_found = [bool]$uninstallerPath
    shortcut_found = $shortcutFoundBeforeUninstall
  }
  first_launch = [ordered]@{ started = $firstRootPid -gt 0; root_pid = $firstRootPid; aioncore_observed = $firstAionCore }
  restart = [ordered]@{ started = $restartRootPid -gt 0; root_pid = $restartRootPid; aioncore_observed = $restartAionCore }
  shutdown = [ordered]@{
    first_launch_surviving_owned_pids = @($firstSurvivors)
    restart_surviving_owned_pids = @($restartSurvivors)
  }
  uninstall = [ordered]@{
    exit_code = $uninstallExitCode
    process_residue_count = @($processResidue).Count
    install_residue_count = $installResidueCount
    shortcut_residue_count = $shortcutResidueCount
    registry_residue_count = $registryResidueCount
    disposable_profile_removed = $profileRemoved
  }
  runtime = [ordered]@{
    receipt_status = [string](Get-OptionalProperty $evidenceRuntimeReceipt 'status' 'missing')
    receipt_platform = [string](Get-OptionalProperty $runtimeProvenance 'platform' 'missing')
    runtime_profile = [string](Get-OptionalProperty $evidenceRuntimeReceipt 'runtime_profile' 'missing')
    python_source = [string](Get-OptionalProperty $runtimePython 'source' 'missing')
    hermes_executable_path = $hermesExecutablePath
    hermes_executable_found = $hermesExecutableFound
    hermes_required_version = [string](Get-OptionalProperty $runtimeHermes 'required_version' '')
    hermes_installed_version = [string](Get-OptionalProperty $runtimeHermes 'installed_version' '')
    hermes_version_probe_exit_code = $versionProbeExitCode
    hermes_version_probe_output = $versionProbeOutput
    ollama_stage_status = Get-StageStatus -Receipt $evidenceRuntimeReceipt -StageId 'ollama'
    model_stage_status = Get-StageStatus -Receipt $evidenceRuntimeReceipt -StageId 'model'
  }
  cloud = [ordered]@{
    credential_available = $credentialAvailable
    registration_ok = [bool]((Get-OptionalProperty $seatProvision 'registration_ok' $false) -eq $true)
    entitlement_activation_ok = [bool]((Get-OptionalProperty $seatProvision 'entitlement_activation_ok' $false) -eq $true)
    encrypted_license_wire_present = [bool]((Get-OptionalProperty $licenseWireProof 'encrypted_license_wire_present' $false) -eq $true -and (Get-OptionalProperty $licenseWireProof 'round_trip_verified' $false) -eq $true)
    license_wire_profile_binding_verified = [bool]((Get-OptionalProperty $licenseWireProof 'profile_binding_verified' $false) -eq $true)
    plaintext_license_wire_present = [bool]((Get-OptionalProperty $licenseWireProof 'plaintext_license_wire_present' $false) -eq $true)
    plaintext_test_seat_finding_count = $plaintextTestSeatFindingCount
    hermes_exit_code = if ($firstTurn) { [int]$firstTurn.ExitCode } else { -1 }
    response_marker_found = $firstTurnOutput.Trim() -ceq 'WINDOWS_X64_CLOUD_CHAT_OK'
    response_complete = [bool]($firstTurn -and -not $firstTurn.TimedOut -and $firstTurnOutput.Trim().Length -gt 0)
    prompt_proof_ok = [bool]((Get-OptionalProperty $promptProof 'ok' $false) -eq $true)
    prompt_proof_marker = [string](Get-OptionalProperty $promptProof 'marker' 'none')
    egress_provider_kind = [string](Get-OptionalProperty $egressProvider 'kind' 'missing')
    egress_decision = [string](Get-OptionalProperty $egressReceipt 'decision' 'missing')
    egress_raw_text_stored = [bool](Get-OptionalProperty $egressReceipt 'raw_text_stored' $true)
    provider_secret_finding_count = $providerSecretFindingCount
    cancel_requested = $cancelRequested
    cancel_surviving_owned_pids = @($cancelSurvivors)
    restart_turn_exit_code = if ($restartTurn) { [int]$restartTurn.ExitCode } else { -1 }
    restart_turn_marker_found = $restartTurnOutput.Trim() -ceq 'WINDOWS_X64_RESTART_OK'
    credits_before = $creditsBefore
    credits_after = $creditsAfter
  }
  harness_errors = @($fatalErrors)
  completion_sentinel = 'WIN_PHASE_A_RAW_EVIDENCE_COMPLETE'
}
Write-AtomicJson -Path $rawEvidencePath -Value $rawEvidence

& bun x tsx scripts/windows/evaluateWindowsPhaseA.ts --raw $rawEvidencePath --gate-dir $gateRoot
exit $LASTEXITCODE
