$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

# Command EVE Windows worker boundary. This process is the only child Hermes
# starts. It validates the role gate, injects the short-lived lease, forces the
# ACP filesystem capability to read-only, and contains the adapter tree in a
# kill-on-close Windows Job Object. It writes protocol data only to stdout.

function Exit-LauncherError {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [int]$Code = 2
  )
  [Console]::Error.WriteLine("eve-acp-launcher: $Message")
  exit $Code
}

$Role = ''
$StatusFile = ''
$TokenFile = ''
$McpConfig = ''
$TimeoutSeconds = 7200
$ReadOnly = $false
$AdapterParts = New-Object 'System.Collections.Generic.List[string]'

for ($Index = 0; $Index -lt $args.Count; $Index += 1) {
  $Current = [string]$args[$Index]
  switch -CaseSensitive ($Current) {
    '--role' {
      if ($Index + 1 -ge $args.Count) { Exit-LauncherError 'missing value for --role' }
      $Index += 1
      $Role = [string]$args[$Index]
    }
    '--status-file' {
      if ($Index + 1 -ge $args.Count) { Exit-LauncherError 'missing value for --status-file' }
      $Index += 1
      $StatusFile = [string]$args[$Index]
    }
    '--token-file' {
      if ($Index + 1 -ge $args.Count) { Exit-LauncherError 'missing value for --token-file' }
      $Index += 1
      $TokenFile = [string]$args[$Index]
    }
    '--mcp-config' {
      if ($Index + 1 -ge $args.Count) { Exit-LauncherError 'missing value for --mcp-config' }
      $Index += 1
      $McpConfig = [string]$args[$Index]
    }
    '--timeout-seconds' {
      if ($Index + 1 -ge $args.Count) { Exit-LauncherError 'missing value for --timeout-seconds' }
      $Index += 1
      $ParsedTimeout = 0
      if (-not [int]::TryParse([string]$args[$Index], [ref]$ParsedTimeout)) {
        Exit-LauncherError 'invalid --timeout-seconds value'
      }
      $TimeoutSeconds = [Math]::Min(86400, [Math]::Max(60, $ParsedTimeout))
    }
    '--read-only' {
      $ReadOnly = $true
    }
    '--' {
      for ($AdapterIndex = $Index + 1; $AdapterIndex -lt $args.Count; $AdapterIndex += 1) {
        $AdapterParts.Add([string]$args[$AdapterIndex])
      }
      $Index = $args.Count
    }
    default {
      Exit-LauncherError 'unexpected launcher argument'
    }
  }
}

if ([string]::IsNullOrWhiteSpace($Role)) { Exit-LauncherError 'missing --role' }
if ([string]::IsNullOrWhiteSpace($StatusFile)) { Exit-LauncherError 'missing --status-file' }
if ([string]::IsNullOrWhiteSpace($TokenFile)) { Exit-LauncherError 'missing --token-file' }
if ($AdapterParts.Count -eq 0) { Exit-LauncherError 'missing adapter command after --' }
if (-not (Test-Path -LiteralPath $StatusFile -PathType Leaf)) {
  Exit-LauncherError 'status file expected but unreadable' 3
}

$Status = (Get-Content -LiteralPath $StatusFile -Raw).Trim()
if ($Status -ne 'active') {
  Exit-LauncherError "role $Role is not active" 3
}
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
  Exit-LauncherError 'lease token file expected but unreadable' 3
}
$LeaseToken = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($LeaseToken)) {
  Exit-LauncherError 'lease token is empty' 3
}

# Build the adapter environment from a minimum allowlist instead of trying to
# predict every future provider secret. The worker gets Windows process basics,
# its local Claude login directory, the role id, and the scoped lease only.
$NeverDelegateEnvironmentNames = @(
  'COMMAND_EVE_ASSISTANT_KEY',
  'COMMAND_EVE_SHIM_AUTH_TOKEN_FILE',
  'COMMAND_EVE_TEAM_MANAGE_BEARER',
  'COMMAND_EVE_TEAM_MANAGE_BEARER_FILE',
  'COMMAND_EVE_KANBAN_ACP_BEARER',
  'COMMAND_EVE_KANBAN_ACP_BEARER_FILE',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'HERMES_COPILOT_ACP_COMMAND',
  'HERMES_COPILOT_ACP_ARGS',
  'COMMAND_EVE_LAUNCHER_DIR',
  'STATUS_FILE',
  'TOKEN_FILE'
)
$AllowedInheritedEnvironmentNames = @(
  'ALLUSERSPROFILE',
  'APPDATA',
  'CLAUDE_CONFIG_DIR',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ComSpec',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TZ',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR'
)
foreach ($Name in $NeverDelegateEnvironmentNames) {
  if ($AllowedInheritedEnvironmentNames -contains $Name) {
    Exit-LauncherError 'delegate environment policy is internally inconsistent'
  }
}
$ChildEnvironment = @{}
foreach ($Name in $AllowedInheritedEnvironmentNames) {
  $Value = [Environment]::GetEnvironmentVariable($Name, [EnvironmentVariableTarget]::Process)
  if ($null -ne $Value) { $ChildEnvironment[$Name] = $Value }
}
$ChildEnvironment['EVE_AGENT_ID'] = $Role
$ChildEnvironment['EVE_LEASE_TOKEN'] = $LeaseToken
$ChildEnvironment['COMMAND_EVE_DELEGATE_READ_ONLY'] = if ($ReadOnly) { '1' } else { '0' }
if (-not $ReadOnly -and -not [string]::IsNullOrWhiteSpace($McpConfig) -and (Test-Path -LiteralPath $McpConfig -PathType Leaf)) {
  $ChildEnvironment['CLAUDE_MCP_CONFIG'] = $McpConfig
}

function ConvertTo-WindowsProcessArgument {
  param([AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $Builder = New-Object System.Text.StringBuilder
  $null = $Builder.Append('"')
  $Backslashes = 0
  foreach ($Character in $Value.ToCharArray()) {
    if ($Character -eq '\') {
      $Backslashes += 1
      continue
    }
    if ($Character -eq '"') {
      $null = $Builder.Append(('\' * (($Backslashes * 2) + 1)))
      $null = $Builder.Append('"')
      $Backslashes = 0
      continue
    }
    if ($Backslashes -gt 0) {
      $null = $Builder.Append(('\' * $Backslashes))
      $Backslashes = 0
    }
    $null = $Builder.Append($Character)
  }
  if ($Backslashes -gt 0) { $null = $Builder.Append(('\' * ($Backslashes * 2))) }
  $null = $Builder.Append('"')
  return $Builder.ToString()
}

$AdapterCommand = [string]$AdapterParts[0]
$ResolvedCommand = $null
if ([IO.Path]::IsPathRooted($AdapterCommand)) {
  if (Test-Path -LiteralPath $AdapterCommand -PathType Leaf) {
    $ResolvedCommand = (Get-Item -LiteralPath $AdapterCommand).FullName
  }
} else {
  $CommandInfo = Get-Command -Name $AdapterCommand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $CommandInfo) { $ResolvedCommand = $CommandInfo.Source }
}
if ([string]::IsNullOrWhiteSpace([string]$ResolvedCommand)) {
  Exit-LauncherError 'adapter executable could not be resolved'
}
$Extension = [IO.Path]::GetExtension([string]$ResolvedCommand).ToLowerInvariant()
if ($Extension -eq '.cmd' -or $Extension -eq '.bat' -or $Extension -eq '.ps1') {
  Exit-LauncherError 'adapter must resolve to a native executable'
}

$StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$StartInfo.FileName = [string]$ResolvedCommand
$StartInfo.UseShellExecute = $false
$StartInfo.CreateNoWindow = $true
$StartInfo.RedirectStandardInput = $true
$StartInfo.RedirectStandardOutput = $true
$StartInfo.RedirectStandardError = $true
$StartInfo.StandardOutputEncoding = $Utf8NoBom
$StartInfo.StandardErrorEncoding = $Utf8NoBom
$StartInfo.WorkingDirectory = (Get-Location).Path
$StartInfo.EnvironmentVariables.Clear()
foreach ($Name in $ChildEnvironment.Keys) {
  $StartInfo.EnvironmentVariables[[string]$Name] = [string]$ChildEnvironment[$Name]
}
$QuotedArguments = New-Object 'System.Collections.Generic.List[string]'
for ($Index = 1; $Index -lt $AdapterParts.Count; $Index += 1) {
  $QuotedArguments.Add((ConvertTo-WindowsProcessArgument ([string]$AdapterParts[$Index])))
}
$StartInfo.Arguments = [string]::Join(' ', $QuotedArguments.ToArray())

$JobType = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class CommandEveWorkerJob
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnClose()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

        var information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length))
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return job;
    }
}

public sealed class CommandEveBoundedLineReader
{
    private readonly TextReader _reader;
    private readonly int _maxLineCharacters;
    private readonly int _maxQueuedLines;
    private readonly int _maxQueuedCharacters;
    private readonly char[] _buffer = new char[4096];
    private readonly StringBuilder _current = new StringBuilder();
    private readonly Queue<string> _lines = new Queue<string>();
    private int _queuedCharacters;
    private Task<int> _pending;
    private bool _eof;

    public CommandEveBoundedLineReader(
        TextReader reader,
        int maxLineCharacters,
        int maxQueuedLines,
        int maxQueuedCharacters)
    {
        if (reader == null) throw new ArgumentNullException("reader");
        if (maxLineCharacters < 1 || maxQueuedLines < 1 || maxQueuedCharacters < maxLineCharacters)
        {
            throw new ArgumentOutOfRangeException();
        }
        _reader = reader;
        _maxLineCharacters = maxLineCharacters;
        _maxQueuedLines = maxQueuedLines;
        _maxQueuedCharacters = maxQueuedCharacters;
    }

    public bool IsCompleted
    {
        get { return _eof && _pending == null && _lines.Count == 0; }
    }

    public void Pump()
    {
        if (_pending == null && !_eof)
        {
            _pending = Task<int>.Factory.StartNew(
                delegate { return _reader.Read(_buffer, 0, _buffer.Length); },
                CancellationToken.None,
                TaskCreationOptions.DenyChildAttach,
                TaskScheduler.Default);
        }
        if (_pending == null || !_pending.IsCompleted) return;

        int count = _pending.GetAwaiter().GetResult();
        _pending = null;
        if (count == 0)
        {
            _eof = true;
            if (_current.Length > 0) EnqueueCurrent();
            return;
        }

        for (int index = 0; index < count; index += 1)
        {
            char value = _buffer[index];
            if (value == '\n')
            {
                EnqueueCurrent();
                continue;
            }
            _current.Append(value);
            if (_current.Length > _maxLineCharacters)
            {
                throw new InvalidDataException("ACP protocol line exceeds the bounded character limit");
            }
        }
    }

    public bool TryReadLine(out string line)
    {
        if (_lines.Count == 0)
        {
            line = null;
            return false;
        }
        line = _lines.Dequeue();
        _queuedCharacters -= line.Length;
        return true;
    }

    private void EnqueueCurrent()
    {
        if (
            _lines.Count >= _maxQueuedLines ||
            _queuedCharacters + _current.Length > _maxQueuedCharacters)
        {
            throw new InvalidDataException("ACP protocol input queue exceeds its bounded capacity");
        }
        if (_current.Length > 0 && _current[_current.Length - 1] == '\r')
        {
            _current.Length -= 1;
        }
        string line = _current.ToString();
        _lines.Enqueue(line);
        _queuedCharacters += line.Length;
        _current.Clear();
    }
}

public sealed class CommandEveBoundedLineWriter
{
    private readonly TextWriter _writer;
    private readonly int _maxLineCharacters;
    private readonly int _maxQueuedLines;
    private readonly int _maxQueuedCharacters;
    private readonly Queue<string> _lines = new Queue<string>();
    private int _queuedCharacters;
    private Task _pending;
    private bool _closeRequested;
    private bool _closeStarted;

    public CommandEveBoundedLineWriter(
        TextWriter writer,
        int maxLineCharacters,
        int maxQueuedLines,
        int maxQueuedCharacters)
    {
        if (writer == null) throw new ArgumentNullException("writer");
        if (maxLineCharacters < 1 || maxQueuedLines < 1 || maxQueuedCharacters < maxLineCharacters)
        {
            throw new ArgumentOutOfRangeException();
        }
        _writer = writer;
        _maxLineCharacters = maxLineCharacters;
        _maxQueuedLines = maxQueuedLines;
        _maxQueuedCharacters = maxQueuedCharacters;
    }

    public bool IsDrained
    {
        get
        {
            return _pending == null && _lines.Count == 0 && (!_closeRequested || _closeStarted);
        }
    }

    public void Enqueue(string line)
    {
        if (line == null) throw new ArgumentNullException("line");
        if (_closeRequested) throw new InvalidOperationException("ACP protocol writer is closing");
        if (line.Length > _maxLineCharacters)
        {
            throw new InvalidDataException("ACP protocol line exceeds the bounded character limit");
        }
        if (_lines.Count >= _maxQueuedLines || _queuedCharacters + line.Length > _maxQueuedCharacters)
        {
            throw new InvalidDataException("ACP protocol output queue exceeds its bounded capacity");
        }
        _lines.Enqueue(line);
        _queuedCharacters += line.Length;
    }

    public void RequestClose()
    {
        _closeRequested = true;
    }

    public void Pump()
    {
        if (_pending != null)
        {
            if (!_pending.IsCompleted) return;
            _pending.GetAwaiter().GetResult();
            _pending = null;
        }
        if (_closeStarted) return;
        if (_lines.Count > 0)
        {
            string line = _lines.Dequeue();
            _queuedCharacters -= line.Length;
            _pending = Task.Factory.StartNew(
                delegate
                {
                    _writer.WriteLine(line);
                    _writer.Flush();
                },
                CancellationToken.None,
                TaskCreationOptions.DenyChildAttach,
                TaskScheduler.Default);
            return;
        }
        if (_closeRequested)
        {
            _closeStarted = true;
            _pending = Task.Factory.StartNew(
                delegate { _writer.Close(); },
                CancellationToken.None,
                TaskCreationOptions.DenyChildAttach,
                TaskScheduler.Default);
        }
    }
}
'@
$null = Add-Type -TypeDefinition $JobType -Language CSharp

function Get-ProtocolProperty {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $Property = $Object.PSObject.Properties[$Name]
  if ($null -eq $Property) { return $null }
  return $Property.Value
}

function Set-ProtocolProperty {
  param([object]$Object, [string]$Name, [AllowNull()][object]$Value)
  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Get-OrCreateProtocolObject {
  param([object]$Object, [string]$Name)
  $Value = Get-ProtocolProperty $Object $Name
  if ($null -eq $Value -or $Value -isnot [PSCustomObject]) {
    $Value = [PSCustomObject]@{}
    Set-ProtocolProperty $Object $Name $Value
  }
  return $Value
}

function Protect-ClientProtocolLine {
  param([string]$Line, [bool]$EnforceReadOnly)
  if (-not $EnforceReadOnly) { return $Line }
  try {
    $Message = $Line | ConvertFrom-Json
  } catch {
    throw 'read-only ACP client line was not valid JSON'
  }
  if ($null -eq $Message -or $Message -isnot [PSCustomObject]) {
    throw 'read-only ACP client line was not a JSON object'
  }

  $Method = [string](Get-ProtocolProperty $Message 'method')
  try {
    if ($Method -eq 'initialize') {
      $Params = Get-OrCreateProtocolObject $Message 'params'
      $ClientCapabilities = Get-OrCreateProtocolObject $Params 'clientCapabilities'
      $FileSystemCapabilities = Get-OrCreateProtocolObject $ClientCapabilities 'fs'
      Set-ProtocolProperty $FileSystemCapabilities 'writeTextFile' $false
      Set-ProtocolProperty $ClientCapabilities 'terminal' $false
      return ($Message | ConvertTo-Json -Compress -Depth 32)
    }

    $SessionStartMethods = @('session/new', 'session/load', 'session/resume', 'session/fork')
    if ($SessionStartMethods -contains $Method) {
      $Params = Get-OrCreateProtocolObject $Message 'params'
      $Meta = Get-OrCreateProtocolObject $Params '_meta'
      $SafeOptions = [PSCustomObject]@{
        tools = @('Read', 'Glob', 'Grep')
        disallowedTools = @('Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'Agent', 'ComputerUse')
        settingSources = @()
        env = [PSCustomObject]@{}
        mcpServers = [PSCustomObject]@{}
        hooks = [PSCustomObject]@{}
        extraArgs = [PSCustomObject]@{}
        additionalDirectories = @()
      }
      Set-ProtocolProperty $Meta 'claudeCode' ([PSCustomObject]@{ options = $SafeOptions })
      Set-ProtocolProperty $Params 'mcpServers' ([object[]]@())
      Set-ProtocolProperty $Params 'additionalDirectories' ([object[]]@())
      return ($Message | ConvertTo-Json -Compress -Depth 32)
    }
  } catch {
    throw "read-only ACP request could not be constrained: $($_.Exception.Message)"
  }
  return $Line
}

function Get-BlockedWriteRequest {
  param([string]$Line, [bool]$EnforceReadOnly)
  if (-not $EnforceReadOnly) { return $null }
  try {
    $Message = $Line | ConvertFrom-Json
  } catch {
    throw 'read-only ACP adapter line was not valid JSON'
  }
  if ($null -eq $Message -or $Message -isnot [PSCustomObject]) {
    throw 'read-only ACP adapter line was not a JSON object'
  }
  $Method = [string](Get-ProtocolProperty $Message 'method')
  $BlockedMethods = @(
    'fs/write_text_file',
    'fs/create_directory',
    'fs/delete',
    'fs/rename',
    'fs/move',
    'terminal/create'
  )
  if ($BlockedMethods -contains $Method) {
    return [PSCustomObject]@{ Id = (Get-ProtocolProperty $Message 'id'); Method = $Method }
  }
  return $null
}

$Process = $null
$Job = [IntPtr]::Zero
$ExitCode = 2
$MaxProtocolLineCharacters = 16 * 1024 * 1024
$MaxQueuedProtocolLines = 1024
$MaxQueuedProtocolCharacters = 32 * 1024 * 1024
try {
  $Job = [CommandEveWorkerJob]::CreateKillOnClose()
  $Process = New-Object System.Diagnostics.Process
  $Process.StartInfo = $StartInfo
  if (-not $Process.Start()) { throw 'adapter process did not start' }
  if (-not [CommandEveWorkerJob]::AssignProcessToJobObject($Job, $Process.Handle)) {
    $ErrorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    try { $Process.Kill() } catch {}
    throw "adapter process could not enter the containment job ($ErrorCode)"
  }

  $Process.StandardInput.AutoFlush = $true
  $ClientReader = [CommandEveBoundedLineReader]::new(
    [Console]::In,
    $MaxProtocolLineCharacters,
    $MaxQueuedProtocolLines,
    $MaxQueuedProtocolCharacters
  )
  $AdapterOutputReader = [CommandEveBoundedLineReader]::new(
    $Process.StandardOutput,
    $MaxProtocolLineCharacters,
    $MaxQueuedProtocolLines,
    $MaxQueuedProtocolCharacters
  )
  $AdapterErrorReader = [CommandEveBoundedLineReader]::new(
    $Process.StandardError,
    $MaxProtocolLineCharacters,
    $MaxQueuedProtocolLines,
    $MaxQueuedProtocolCharacters
  )
  $AdapterInputWriter = [CommandEveBoundedLineWriter]::new(
    $Process.StandardInput,
    $MaxProtocolLineCharacters,
    $MaxQueuedProtocolLines,
    $MaxQueuedProtocolCharacters
  )
  $ClientOutputWriter = [CommandEveBoundedLineWriter]::new(
    [Console]::Out,
    $MaxProtocolLineCharacters,
    $MaxQueuedProtocolLines,
    $MaxQueuedProtocolCharacters
  )
  $ClientErrorWriter = [CommandEveBoundedLineWriter]::new(
    [Console]::Error,
    $MaxProtocolLineCharacters,
    $MaxQueuedProtocolLines,
    $MaxQueuedProtocolCharacters
  )
  $AdapterInputCloseRequested = $false
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

  while ($true) {
    if ([DateTime]::UtcNow -ge $Deadline) { throw [TimeoutException]::new('worker exceeded its bounded runtime') }
    $ClientReader.Pump()
    $AdapterOutputReader.Pump()
    $AdapterErrorReader.Pump()
    $AdapterInputWriter.Pump()
    $ClientOutputWriter.Pump()
    $ClientErrorWriter.Pump()

    $Line = $null
    while ($ClientReader.TryReadLine([ref]$Line)) {
      $AdapterInputWriter.Enqueue((Protect-ClientProtocolLine $Line $ReadOnly))
      $Line = $null
    }

    $Line = $null
    while ($AdapterOutputReader.TryReadLine([ref]$Line)) {
      $Blocked = Get-BlockedWriteRequest $Line $ReadOnly
      if ($null -ne $Blocked) {
        if ($null -ne $Blocked.Id) {
          $Response = @{
            jsonrpc = '2.0'
            id = $Blocked.Id
            error = @{ code = -32604; message = 'Command EVE worker is read-only.' }
          } | ConvertTo-Json -Compress -Depth 8
          $AdapterInputWriter.Enqueue($Response)
        }
      } else {
        $ClientOutputWriter.Enqueue($Line)
      }
      $Line = $null
    }

    $Line = $null
    while ($AdapterErrorReader.TryReadLine([ref]$Line)) {
      $ClientErrorWriter.Enqueue($Line)
      $Line = $null
    }

    if ($ClientReader.IsCompleted -and -not $AdapterInputCloseRequested) {
      $AdapterInputWriter.RequestClose()
      $AdapterInputCloseRequested = $true
    }

    if (
      $Process.HasExited -and
      $AdapterOutputReader.IsCompleted -and
      $AdapterErrorReader.IsCompleted -and
      $ClientOutputWriter.IsDrained -and
      $ClientErrorWriter.IsDrained
    ) { break }
    Start-Sleep -Milliseconds 10
  }

  $Process.WaitForExit()
  $ExitCode = $Process.ExitCode
} catch [TimeoutException] {
  [Console]::Error.WriteLine('eve-acp-launcher: worker exceeded its bounded runtime')
  $ExitCode = 124
} catch {
  [Console]::Error.WriteLine('eve-acp-launcher: worker boundary failed closed')
  $ExitCode = 2
} finally {
  if ($null -ne $Process) {
    try {
      if (-not $Process.HasExited) { $Process.Kill() }
    } catch {}
  }
  if ($Job -ne [IntPtr]::Zero) {
    $null = [CommandEveWorkerJob]::CloseHandle($Job)
  }
}

exit $ExitCode
