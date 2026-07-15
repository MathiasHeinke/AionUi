param(
  [Parameter(Mandatory = $true)]
  [string]$RunnerArchivePath,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{64}$')]
  [string]$ExpectedArchiveSha256,
  [Parameter(Mandatory = $true)]
  [string]$JitConfigPath,
  [Parameter(Mandatory = $true)]
  [string]$EvidenceDirectory,
  [ValidatePattern('^[a-zA-Z0-9-]{1,80}$')]
  [string]$RunId = ([guid]::NewGuid().ToString('N')),
  [int]$TimeoutSeconds = 14400,
  [int]$HeartbeatSeconds = 30
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
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $absolute -Force
}

function Get-RunnerScopedProcessIds {
  param([string]$RunnerRoot)
  $needle = [System.IO.Path]::GetFullPath($RunnerRoot)
  return @(
    Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        $executablePath = [string]$_.ExecutablePath
        $commandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          $executablePath.StartsWith($needle, [System.StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { [int]$_.ProcessId } |
      Where-Object { $_ -ne $PID } |
      Sort-Object -Unique
  )
}

function Stop-RunnerProcessTree {
  param([int]$RootPid, [string]$RunnerRoot)
  if ($RootPid -gt 0 -and (Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & taskkill.exe /PID $RootPid /T /F 2>$null | Out-Null
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
  }
  foreach ($processId in @(Get-RunnerScopedProcessIds -RunnerRoot $RunnerRoot)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  return @(Get-RunnerScopedProcessIds -RunnerRoot $RunnerRoot)
}

function Copy-And-RedactDiagnostics {
  param([string]$RunnerRoot, [string]$Destination, [string]$JitConfig)
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $diagSource = Join-Path $RunnerRoot '_diag'
  if (Test-Path -LiteralPath $diagSource -PathType Container) {
    Copy-Item -LiteralPath $diagSource -Destination (Join-Path $Destination '_diag') -Recurse -Force
  }

  $redactionCount = 0
  $secretPattern = '(?i)(github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{20,}|authorization\s*:\s*(?:bearer\s+)?\S+|(?:access_token|client_secret|refresh_token|registration_token|runner_token)\s*[:=]\s*["'']?[^"''\s,}]+|[?&](?:token|access_token|client_secret)=[^&\s]+)'
  foreach ($file in @(Get-ChildItem -LiteralPath $Destination -File -Recurse -ErrorAction SilentlyContinue)) {
    $text = [System.IO.File]::ReadAllText($file.FullName)
    $redacted = $text.Replace($JitConfig, '[REDACTED_JIT_CONFIG]')
    $redacted = [regex]::Replace($redacted, $secretPattern, '[REDACTED_CREDENTIAL]')
    if ($redacted -ne $text) {
      $redactionCount += 1
      [System.IO.File]::WriteAllText($file.FullName, $redacted, [System.Text.UTF8Encoding]::new($false))
    }
  }

  $remainingSecretFindings = 0
  foreach ($file in @(Get-ChildItem -LiteralPath $Destination -File -Recurse -ErrorAction SilentlyContinue)) {
    $text = [System.IO.File]::ReadAllText($file.FullName)
    if ($text.IndexOf($JitConfig, [System.StringComparison]::Ordinal) -ge 0 -or [regex]::IsMatch($text, $secretPattern)) {
      $remainingSecretFindings += 1
    }
  }
  return [pscustomobject]@{
    FileCount = @(Get-ChildItem -LiteralPath $Destination -File -Recurse -ErrorAction SilentlyContinue).Count
    RedactionCount = $redactionCount
    RemainingSecretFindingCount = $remainingSecretFindings
  }
}

$startedAt = [DateTimeOffset]::UtcNow
$absoluteArchivePath = [System.IO.Path]::GetFullPath($RunnerArchivePath)
$absoluteJitConfigPath = [System.IO.Path]::GetFullPath($JitConfigPath)
$absoluteEvidenceDirectory = [System.IO.Path]::GetFullPath($EvidenceDirectory)
$jitInputRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CommandEVE\jit-input'))
$jitInputPrefix = $jitInputRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$runnerParent = Join-Path $env:LOCALAPPDATA 'CommandEVE\phase-b-runners'
$runnerRoot = Join-Path $runnerParent $RunId
$runEvidenceDirectory = Join-Path $absoluteEvidenceDirectory $RunId
$absoluteRunEvidenceDirectory = [System.IO.Path]::GetFullPath($runEvidenceDirectory)
$absoluteRunnerRoot = [System.IO.Path]::GetFullPath($runnerRoot)
$runnerRootPrefix = $absoluteRunnerRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$evidencePathRejected =
  $absoluteRunEvidenceDirectory -eq $absoluteRunnerRoot -or
  $absoluteRunEvidenceDirectory.StartsWith($runnerRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
if ($evidencePathRejected) {
  $runEvidenceDirectory = Join-Path $env:LOCALAPPDATA "CommandEVE\phase-b-rejected-evidence\$RunId"
  $absoluteRunEvidenceDirectory = [System.IO.Path]::GetFullPath($runEvidenceDirectory)
}
$stdoutPath = Join-Path $runEvidenceDirectory 'runner-stdout.log'
$stderrPath = Join-Path $runEvidenceDirectory 'runner-stderr.log'
$receiptPath = Join-Path $runEvidenceDirectory 'runner-cleanup-receipt.json'
$runnerPid = 0
$process = $null
$runnerExitCode = 1
$timedOut = $false
$failureCode = $null
$jitConfig = ''
$diagnostics = [pscustomobject]@{ FileCount = 0; RedactionCount = 0; RemainingSecretFindingCount = 0 }
$survivingPids = @()
$preexistingCredentialFileCount = -1
$logDrainTimedOut = $false

New-Item -ItemType Directory -Path $absoluteRunEvidenceDirectory -Force | Out-Null

try {
  if ($evidencePathRejected) {
    $failureCode = 'RUNNER_EVIDENCE_PATH_NOT_EXTERNAL'
    throw 'Evidence directory must be outside the disposable runner root.'
  }
  if (-not $absoluteJitConfigPath.StartsWith($jitInputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    $failureCode = 'JIT_CONFIG_OUTSIDE_PRIVATE_INPUT_ROOT'
    throw 'JIT configuration file is outside the private input root.'
  }
  if (-not (Test-Path -LiteralPath $absoluteArchivePath -PathType Leaf)) {
    $failureCode = 'RUNNER_ARCHIVE_MISSING'
    throw 'Runner archive is missing.'
  }
  if ([System.IO.Path]::GetFileName($absoluteArchivePath) -notmatch '^actions-runner-win-x64-[0-9]+\.[0-9]+\.[0-9]+\.zip$') {
    $failureCode = 'RUNNER_ARCHIVE_NOT_WIN_X64'
    throw 'Runner archive name does not prove the Windows x64 release asset.'
  }
  $actualArchiveSha256 = (Get-FileHash -LiteralPath $absoluteArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualArchiveSha256 -ne $ExpectedArchiveSha256) {
    $failureCode = 'RUNNER_ARCHIVE_HASH_MISMATCH'
    throw 'Runner archive SHA-256 mismatch.'
  }
  if (-not (Test-Path -LiteralPath $absoluteJitConfigPath -PathType Leaf)) {
    $failureCode = 'JIT_CONFIG_MISSING'
    throw 'JIT configuration file is missing.'
  }
  $jitConfig = [System.IO.File]::ReadAllText($absoluteJitConfigPath).Trim()
  Remove-Item -LiteralPath $absoluteJitConfigPath -Force
  if ($jitConfig.Length -lt 80 -or $jitConfig -notmatch '^[A-Za-z0-9+/=_-]+$') {
    $failureCode = 'JIT_CONFIG_INVALID'
    throw 'JIT configuration is malformed.'
  }
  if (Test-Path -LiteralPath $runnerRoot) {
    $failureCode = 'RUNNER_ROOT_ALREADY_EXISTS'
    throw 'Disposable runner root already exists.'
  }

  New-Item -ItemType Directory -Path $runnerRoot -Force | Out-Null
  Expand-Archive -LiteralPath $absoluteArchivePath -DestinationPath $runnerRoot -Force
  $runCommand = Join-Path $runnerRoot 'run.cmd'
  if (-not (Test-Path -LiteralPath $runCommand -PathType Leaf)) {
    $failureCode = 'RUNNER_ENTRYPOINT_MISSING'
    throw 'Runner run.cmd is missing after extraction.'
  }

  $credentialFileNames = @('.runner', '.credentials', '.credentials_rsaparams')
  $preexistingCredentialFileCount = @(
    $credentialFileNames |
      ForEach-Object { Join-Path $runnerRoot $_ } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  ).Count
  if ($preexistingCredentialFileCount -ne 0) {
    $failureCode = 'RUNNER_CREDENTIAL_RESIDUE'
    throw 'Runner archive or disposable root contains registration credential residue before JIT startup.'
  }

  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $env:COMSPEC
  $processInfo.Arguments = "/d /s /c `"`"$runCommand`" --jitconfig $jitConfig`""
  $processInfo.WorkingDirectory = $runnerRoot
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.EnvironmentVariables['COMMAND_EVE_PHASE_B_JIT'] = '1'
  $processInfo.EnvironmentVariables['COMMAND_EVE_PREEXISTING_CREDENTIAL_FILE_COUNT'] = [string]$preexistingCredentialFileCount
  $processInfo.EnvironmentVariables['COMMAND_EVE_RUNNER_ROOT_DISPOSABLE'] = '1'
  $processInfo.EnvironmentVariables['COMMAND_EVE_RUNNER_DIAGNOSTICS_EXTERNALIZED'] = '1'
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $processInfo
  if (-not $process.Start()) {
    $failureCode = 'RUNNER_START_FAILED'
    throw 'Unable to start the JIT runner.'
  }
  $runnerPid = $process.Id
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $nextHeartbeat = [DateTimeOffset]::UtcNow.AddSeconds($HeartbeatSeconds)
  while (-not $process.HasExited -and [DateTimeOffset]::UtcNow -lt $deadline) {
    [void]$process.WaitForExit(1000)
    if (-not $process.HasExited -and [DateTimeOffset]::UtcNow -ge $nextHeartbeat) {
      $elapsedSeconds = [int]([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds
      Write-Host "[phase-b] JIT runner heartbeat: ${elapsedSeconds}s elapsed"
      $nextHeartbeat = [DateTimeOffset]::UtcNow.AddSeconds($HeartbeatSeconds)
    }
  }
  if (-not $process.HasExited) {
    $timedOut = $true
    $failureCode = 'RUNNER_TIMEOUT'
    $survivingPids = @(Stop-RunnerProcessTree -RootPid $runnerPid -RunnerRoot $runnerRoot)
  } else {
    $process.WaitForExit()
    $runnerExitCode = $process.ExitCode
    if ($runnerExitCode -ne 0) { $failureCode = 'RUNNER_JOB_FAILED' }
    $survivingPids = @(Stop-RunnerProcessTree -RootPid 0 -RunnerRoot $runnerRoot)
  }
  $streamsCompleted = [System.Threading.Tasks.Task]::WaitAll(
    [System.Threading.Tasks.Task[]]@($stdoutTask, $stderrTask),
    30000
  )
  if (-not $streamsCompleted) {
    $logDrainTimedOut = $true
    if ($null -eq $failureCode) { $failureCode = 'RUNNER_LOG_DRAIN_TIMEOUT' }
  }
  if ($stdoutTask.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
    [System.IO.File]::WriteAllText($stdoutPath, $stdoutTask.Result, [System.Text.UTF8Encoding]::new($false))
  }
  if ($stderrTask.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
    [System.IO.File]::WriteAllText($stderrPath, $stderrTask.Result, [System.Text.UTF8Encoding]::new($false))
  }
} catch {
  if ($null -eq $failureCode) { $failureCode = 'RUNNER_BOOTSTRAP_ERROR' }
  Write-Warning "Phase B JIT runner failed with bounded code $failureCode."
} finally {
  if (-not [string]::IsNullOrWhiteSpace($jitConfig) -and (Test-Path -LiteralPath $runEvidenceDirectory)) {
    try {
      $diagnostics = Copy-And-RedactDiagnostics -RunnerRoot $runnerRoot -Destination $runEvidenceDirectory -JitConfig $jitConfig
    } catch {
      if ($null -eq $failureCode) { $failureCode = 'RUNNER_DIAGNOSTIC_EXPORT_FAILED' }
    }
  }
  if (Test-Path -LiteralPath $absoluteJitConfigPath) {
    Remove-Item -LiteralPath $absoluteJitConfigPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $runnerRoot) {
    $cleanupRunnerPid = 0
    try {
      if ($null -ne $process -and -not $process.HasExited) { $cleanupRunnerPid = $runnerPid }
    } catch {
      $cleanupRunnerPid = 0
    }
    try {
      $survivingPids = @(Stop-RunnerProcessTree -RootPid $cleanupRunnerPid -RunnerRoot $runnerRoot)
    } catch {
      if ($null -eq $failureCode) { $failureCode = 'RUNNER_PROCESS_CLEANUP_FAILED' }
    }
    try {
      Remove-Item -LiteralPath $runnerRoot -Recurse -Force -ErrorAction Stop
    } catch {
      if ($null -eq $failureCode) { $failureCode = 'RUNNER_ROOT_CLEANUP_FAILED' }
    }
  }
  $runnerRootRemoved = -not (Test-Path -LiteralPath $runnerRoot)
  if (-not $runnerRootRemoved -and $null -eq $failureCode) { $failureCode = 'RUNNER_ROOT_CLEANUP_FAILED' }
  if ($survivingPids.Count -gt 0 -and $null -eq $failureCode) { $failureCode = 'RUNNER_PROCESS_RESIDUE' }
  if ($diagnostics.RemainingSecretFindingCount -gt 0 -and $null -eq $failureCode) {
    $failureCode = 'RUNNER_DIAGNOSTIC_SECRET_FINDING'
  }
  $receipt = [ordered]@{
    schema_version = 'command-eve-windows-phase-b-runner-cleanup/v1'
    run_id = $RunId
    started_at = $startedAt.ToString('o')
    completed_at = [DateTimeOffset]::UtcNow.ToString('o')
    runner_exit_code = $runnerExitCode
    timed_out = $timedOut
    failure_code = $failureCode
    runner_root_removed = $runnerRootRemoved
    surviving_owned_pids = @($survivingPids)
    diagnostic_file_count = $diagnostics.FileCount
    diagnostic_redaction_count = $diagnostics.RedactionCount
    diagnostic_secret_finding_count = $diagnostics.RemainingSecretFindingCount
    preexisting_credential_file_count = $preexistingCredentialFileCount
    log_drain_timed_out = $logDrainTimedOut
    jit_config_file_removed = -not (Test-Path -LiteralPath $absoluteJitConfigPath)
    status = if (
      $runnerExitCode -eq 0 -and
      -not $timedOut -and
      $null -eq $failureCode -and
      $runnerRootRemoved -and
      $survivingPids.Count -eq 0 -and
      -not $logDrainTimedOut -and
      $diagnostics.RemainingSecretFindingCount -eq 0
    ) { 'PASS' } else { 'REJECT' }
    completion_sentinel = 'WIN_PHASE_B_JIT_RUNNER_CLEANUP_COMPLETE'
  }
  Write-AtomicJson -Path $receiptPath -Value $receipt
}

if ($receipt.status -ne 'PASS') { exit 1 }
Write-Host "WIN_PHASE_B_JIT_RUNNER_COMPLETE $receiptPath"
