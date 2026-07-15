param(
  [Parameter(Mandatory = $true)]
  [string]$DestinationDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$runnerVersion = '2.335.1'
$runnerSha256 = 'eb65c95277af42bcf3778a799c41359d224ba2a67b4de26b7cea1729b09c803d'
$runnerFileName = "actions-runner-win-x64-$runnerVersion.zip"
$runnerUrl = "https://github.com/actions/runner/releases/download/v$runnerVersion/$runnerFileName"
$absoluteDestination = [System.IO.Path]::GetFullPath($DestinationDirectory)
$archivePath = Join-Path $absoluteDestination $runnerFileName
$receiptPath = Join-Path $absoluteDestination 'runner-archive-receipt.json'

function Write-AtomicJson {
  param([string]$Path, [object]$Value)
  $absolute = [System.IO.Path]::GetFullPath($Path)
  $directory = Split-Path -Parent $absolute
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = "$absolute.$PID.tmp"
  $json = $Value | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $absolute -Force
}

New-Item -ItemType Directory -Path $absoluteDestination -Force | Out-Null
$temporaryArchivePath = "$archivePath.$PID.tmp"
try {
  $needsDownload = $true
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    $existingHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $needsDownload = $existingHash -ne $runnerSha256
  }
  if ($needsDownload) {
    Remove-Item -LiteralPath $temporaryArchivePath -Force -ErrorAction SilentlyContinue
    Write-Host "[phase-b] Downloading pinned GitHub runner $runnerVersion..."
    Invoke-WebRequest -Uri $runnerUrl -OutFile $temporaryArchivePath -UseBasicParsing
    $downloadedHash = (Get-FileHash -LiteralPath $temporaryArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadedHash -ne $runnerSha256) { throw 'Downloaded runner archive SHA-256 mismatch.' }
    Move-Item -LiteralPath $temporaryArchivePath -Destination $archivePath -Force
  }
  $finalHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($finalHash -ne $runnerSha256) { throw 'Cached runner archive SHA-256 mismatch.' }
  $receipt = [ordered]@{
    schema_version = 'command-eve-windows-phase-b-runner-archive/v1'
    runner_version = $runnerVersion
    asset_name = $runnerFileName
    source_url = $runnerUrl
    sha256 = $finalHash
    size_bytes = (Get-Item -LiteralPath $archivePath).Length
    status = 'PASS'
    completed_at = [DateTimeOffset]::UtcNow.ToString('o')
    completion_sentinel = 'WIN_PHASE_B_RUNNER_ARCHIVE_COMPLETE'
  }
  Write-AtomicJson -Path $receiptPath -Value $receipt
} finally {
  Remove-Item -LiteralPath $temporaryArchivePath -Force -ErrorAction SilentlyContinue
}

Write-Host "WIN_PHASE_B_RUNNER_ARCHIVE_COMPLETE archive=$archivePath receipt=$receiptPath"
