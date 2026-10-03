# Hosted disposable Windows runner only. No production paths or credentials.
param([switch]$SelectedUser, [switch]$Peer, [switch]$App, [string]$Node, [string]$Phase, [string]$Root)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows') { throw 'Hosted Windows runner required.' }
$Shell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\powershell.exe')
if ($Peer) {
    if ($SelectedUser -or $Root -cnotmatch '^[A-Z]:\\Users\\ob[a-f0-9]{14}\\obsync native [a-f0-9]{32}$') { throw 'Exact synthetic peer fixture required.' }
    $Stage = [IO.Path]::Combine($Root, 'stage')
    $Sentinel = [IO.Path]::Combine($Stage, 'sentinel.txt')
    $Denied = 0
    try { [IO.Directory]::GetFileSystemEntries($Stage) | Out-Null } catch [UnauthorizedAccessException] { $Denied++ }
    try { [IO.File]::ReadAllText($Sentinel) | Out-Null } catch [UnauthorizedAccessException] { $Denied++ }
    try { [IO.File]::WriteAllText($Sentinel, 'changed') } catch [UnauthorizedAccessException] { $Denied++ }
    if ($Denied -ne 3) { exit 7 }; exit 0
}
if (!$SelectedUser) {
    if ($Root -or $Phase) { throw 'Controller paths cannot be supplied.' }
    $Node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    if ((& $Node --version) -cne 'v26.10.0' -or $LASTEXITCODE -ne 0) { throw 'Controller runtime differs.' }
    $Accounts = @()
    function Invoke-Owned($Account, [Security.SecureString]$Password, [string]$Arguments) {
        # CreateProcessWithLogonW has a 1024-character command-line maximum.
        if ($Shell.Length + $Arguments.Length + 4 -gt 1024) { throw 'Credentialed command-line budget.' }
        $Start = [Diagnostics.ProcessStartInfo]::new($Shell)
        $Start.Arguments = $Arguments
        $Start.WorkingDirectory = (Get-Location).Path
        $Start.UseShellExecute = $false
        $Start.UserName = $Account.Name
        $Start.Domain = '.'
        $Start.Password = $Password
        $Start.LoadUserProfile = $true
        $Start.RedirectStandardInput = $true
        $Start.RedirectStandardOutput = $true
        $Start.RedirectStandardError = $true
        $Start.EnvironmentVariables.Clear()
        $Start.EnvironmentVariables['GITHUB_ACTIONS'] = 'true'
        $Start.EnvironmentVariables['RUNNER_OS'] = 'Windows'
        $Start.EnvironmentVariables['PATHEXT'] = '.EXE'
        $Start.EnvironmentVariables['SystemRoot'] = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
        $Start.EnvironmentVariables['PSModulePath'] = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\Modules')
        if ($App -and $Arguments.Contains('-Phase app ')) { $Start.EnvironmentVariables['OBSYNC_E2E_FIXTURE_TOKEN'] = $AppToken }
        $Child = [Diagnostics.Process]::Start($Start)
        try {
            $Child.StandardInput.Close()
            $Output = $Child.StandardOutput.ReadToEndAsync()
            $Errors = $Child.StandardError.ReadToEndAsync()
            $Budget = if ($App) { 300000 } else { 180000 }
            if (!$Child.WaitForExit($Budget)) { $Child.Kill(); $Child.WaitForExit(); throw 'Native owned process timed out.' }
            $Text = $Output.Result
            $ErrorText = $Errors.Result
            if ($Text.Length + $ErrorText.Length -gt 65536) { throw 'Native process output budget.' }
            if ($Child.ExitCode -ne 0) {
                foreach ($Line in $Text -split '\r?\n') {
                    if ($Line.StartsWith('{"event":"windows_')) { Write-Host $Line }
                }
                # Only synthetic CI output; replace the temporary account path.
                [Console]::Error.WriteLine(($ErrorText -replace 'C:\\Users\\ob[a-f0-9]{14}', '<fixture-profile>'))
                throw ('Native owned process failed: ' + $Child.ExitCode)
            }
            return $Text
        } finally { $Child.Dispose() }
    }
    try {
        $Passwords = @((ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force),
                       (ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force))
        for ($Index = 0; $Index -lt 2; $Index++) {
            $Name = 'ob' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
            $Account = New-LocalUser -Name $Name -Password $Passwords[$Index] -AccountNeverExpires
            $Accounts += $Account
            Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $Name
        }
        $Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -SelectedUser -Node "' + $Node + '"'
        if ($App) { $Arguments += ' -App' }
        $Prepared = Invoke-Owned $Accounts[0] $Passwords[0] ($Arguments + ' -Phase prepare')
        $Ready = @($Prepared -split '\r?\n' | Where-Object { $_.StartsWith('{"event":"fixture_ready",') })
        if ($Ready.Count -ne 1) { throw 'Missing exact prepared fixture.' }
        $Fixture = $Ready[0] | ConvertFrom-Json
        $Profile = Get-CimInstance Win32_UserProfile -Filter ("SID='" + $Accounts[0].SID.Value + "'")
        $Candidate = $Fixture.root
        if ($Candidate -isnot [string] -or [IO.Path]::GetDirectoryName($Candidate) -cne $Profile.LocalPath -or
            [IO.Path]::GetFileName($Candidate) -cnotmatch '^obsync native [a-f0-9]{32}$') { throw 'Invalid prepared fixture binding.' }
        $Owner = [IO.Directory]::GetAccessControl($Candidate).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($Owner -cne $Accounts[0].SID.Value) { throw 'Prepared fixture owner differs.' }
        $Root = $Candidate
        if ($App) {
            $TokenPath = [IO.Path]::GetFullPath($env:OBSYNC_E2E_TOKEN_FILE)
            $Runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
            if (!$TokenPath.StartsWith($Runner, [StringComparison]::OrdinalIgnoreCase) -or
                [IO.Path]::GetFileName($TokenPath) -cne 'token' -or $env:OBSYNC_E2E_URL -cne 'https://obsync-host.invalid:18643') { throw 'Exact app fixture required.' }
            $AppToken = [IO.File]::ReadAllText($TokenPath).Trim()
            if ($AppToken -cnotmatch '^[a-f0-9]{64}$') { throw 'App fixture token shape.' }
            [IO.File]::Delete($TokenPath)
            if (![IO.File]::Exists($env:OBSIDIAN_BIN) -or [IO.Path]::GetFileName($env:OBSIDIAN_BIN) -ine 'Obsidian.exe') { throw 'Pinned fixture app required.' }
            Copy-Item -LiteralPath ([IO.Path]::GetDirectoryName($env:OBSIDIAN_BIN)) -Destination ([IO.Path]::Combine($Root, 'app')) -Recurse
            $AppOutput = Invoke-Owned $Accounts[0] $Passwords[0] ($Arguments + ' -Phase app -Root "' + $Root + '"')
            $Images = [IO.Path]::Combine($env:RUNNER_TEMP, 'windows-export-visuals')
            $null = [IO.Directory]::CreateDirectory($Images)
            foreach ($Mode in @('encrypted', 'open', 'plain')) {
                $Image = [IO.Path]::Combine($Root, 'live', ('windows-export-' + $Mode + '.png'))
                if (([IO.File]::GetAttributes($Image) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ([IO.FileInfo]::new($Image)).Length -gt 8388608) { throw 'Synthetic screenshot boundary.' }
                Copy-Item -LiteralPath $Image -Destination $Images
            }
            foreach ($Line in $AppOutput -split '\r?\n') {
                if ($Line.StartsWith('obsidian-drive: (') -or $Line.StartsWith('obsidian-drive: SUMMARY')) { Write-Output $Line }
            }
            exit 0
        }
        $null = Invoke-Owned $Accounts[1] $Passwords[1] ('-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Peer -Root "' + $Root + '"')
        Write-Output '{"event":"windows_peer_custody","result":"pass"}'
        $Completed = Invoke-Owned $Accounts[0] $Passwords[0] ($Arguments + ' -Phase complete -Root "' + $Root + '"')
        $Exports = Invoke-Owned $Accounts[0] $Passwords[0] ($Arguments + ' -Phase exports -Root "' + $Root + '"')
        foreach ($Line in ($Prepared + "`n" + $Completed + "`n" + $Exports) -split '\r?\n') {
            if ($Line.StartsWith('{') -and !$Line.StartsWith('{"event":"fixture_ready",')) { Write-Output $Line }
        }
    } finally {
        if ($App -and $Root) {
            Get-CimInstance Win32_Process -Filter "Name='Obsidian.exe' OR Name='node.exe'" | Where-Object {
                $_.CommandLine -and $_.CommandLine.Contains($Root)
            } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        }
        if ($Root -and [IO.Directory]::Exists($Root)) { Remove-Item -LiteralPath $Root -Recurse -Force }
        foreach ($Account in $Accounts) {
            Get-CimInstance Win32_UserProfile -Filter ("SID='" + $Account.SID.Value + "'") | Remove-CimInstance
            Remove-LocalUser -SID $Account.SID
        }
    }
    exit 0
}
if (![IO.Path]::IsPathRooted($Node) -or ![IO.File]::Exists($Node)) { throw 'Pinned runtime path required.' }
$RuntimeVersion = & $Node --version
$RuntimeExit = $LASTEXITCODE
if ($RuntimeVersion -cne 'v26.10.0' -or $RuntimeExit -ne 0) {
    $VersionClass = if ($RuntimeVersion -is [string] -and $RuntimeVersion -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { $RuntimeVersion } else { 'no_version' }
    throw ('Selected-user runtime refused: exit=' + $RuntimeExit + '; version=' + $VersionClass)
}
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$User = $Identity.User
if ($Identity.Owner.Value -cne $User.Value) { throw 'An ordinary selected-user token is required.' }
$Profile = [Environment]::GetFolderPath('UserProfile')
$Acl = [Security.AccessControl.DirectorySecurity]::new()
$Acl.SetOwner($User)
$Acl.SetAccessRuleProtection($true, $false)
foreach ($Sid in @($User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($Sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
if ($Phase -ceq 'prepare' -and !$Root) {
    $Root = [IO.Path]::Combine($Profile, 'obsync native ' + [Guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($Root, $Acl)
} elseif ($Phase -cnotin @('complete', 'exports', 'app') -or !$Root -or [IO.Path]::GetDirectoryName($Root) -cne $Profile -or
    [IO.Path]::GetFileName($Root) -cnotmatch '^obsync native [a-f0-9]{32}$') { throw 'Invalid owned fixture phase.' }
$Keep = $false
try {
    $Trust = [IO.Path]::Combine($Root, 'trust')
    $Receipt = [IO.Path]::Combine($Trust, 'powershell.json')
    if ($Phase -ceq 'prepare') {
        $RequestText = [ordered]@{v=1;op='setup';path=$Trust;destination=''} | ConvertTo-Json -Compress
        $Request = [Text.UTF8Encoding]::new($false, $true).GetBytes($RequestText)
        $Start = [Diagnostics.ProcessStartInfo]::new($Shell)
        $Start.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + [IO.Path]::GetFullPath('cli/windows-files.ps1') + '"'
        $Start.UseShellExecute = $false
        $Start.RedirectStandardInput = $true
        # The .NET Framework stdin writer must not prefix the raw JSON with BOM.
        $BeforeEncoding = [Console]::InputEncoding
        try {
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
            $Setup = [Diagnostics.Process]::Start($Start)
        } finally { [Console]::InputEncoding = $BeforeEncoding }
        try {
            $Setup.StandardInput.BaseStream.Write($Request, 0, $Request.Length)
            $Setup.StandardInput.Close()
            if (!$Setup.WaitForExit(15000)) { $Setup.Kill(); $Setup.WaitForExit(); throw 'Trusted OS setup timed out.' }
            if ($Setup.ExitCode -ne 0) { throw 'Trusted OS setup failed.' }
        } finally { $Setup.Dispose() }
        $Digest = (Get-FileHash -LiteralPath $Receipt -Algorithm SHA256).Hash.ToLowerInvariant()
        if (!$App) {
            & $Node scripts/ci/windows-files-process.mjs prepare $Root $Receipt $Digest
            if ($LASTEXITCODE -ne 0) { throw 'Prepare process failed.' }
        }
        $Keep = $true
        Write-Output ([ordered]@{event='fixture_ready';root=$Root} | ConvertTo-Json -Compress)
    } elseif ($Phase -ceq 'app' -and $App) {
        $TokenPath = [IO.Path]::Combine($Root, 'app-token')
        if ($env:OBSYNC_E2E_FIXTURE_TOKEN -cnotmatch '^[a-f0-9]{64}$') { throw 'Missing app fixture token.' }
        [IO.File]::WriteAllText($TokenPath, $env:OBSYNC_E2E_FIXTURE_TOKEN)
        Remove-Item Env:OBSYNC_E2E_FIXTURE_TOKEN
        $env:USERPROFILE = $Profile
        $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
        $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
        $env:TEMP = [IO.Path]::Combine($Root, 'temp'); $null = [IO.Directory]::CreateDirectory($env:TEMP, $Acl); $env:TMP = $env:TEMP
        $env:PATH = [Environment]::SystemDirectory + ';' + [IO.Path]::GetDirectoryName($Shell)
        $env:OBSIDIAN_BIN = [IO.Path]::Combine($Root, 'app\Obsidian.exe')
        $env:OBSYNC_E2E_WORK = [IO.Path]::Combine($Root, 'live')
        $env:OBSYNC_E2E_PLUGIN = [IO.Path]::GetFullPath('plugin/dist')
        $env:OBSYNC_E2E_URL = 'https://obsync-host.invalid:18643'
        $env:OBSYNC_E2E_TOKEN_FILE = $TokenPath
        $env:OBSYNC_E2E_NTFS = '1'
        $env:OBSYNC_E2E_POWERSHELL = $Shell
        $env:OBSYNC_E2E_ARGS = '["--host-resolver-rules=MAP obsync-host.invalid 127.0.0.1"]'
        & $Node scripts/ci/obsidian-drive.mjs $Root
        if ($LASTEXITCODE -ne 0) { throw 'Native app journey failed.' }
    } elseif ($Phase -ceq 'exports') {
        $Digest = (Get-FileHash -LiteralPath $Receipt -Algorithm SHA256).Hash.ToLowerInvariant()
        & $Node scripts/ci/windows-export-process.mjs all $Root $Receipt $Digest
        if ($LASTEXITCODE -ne 0) { throw 'Native shared export journey failed.' }
    } else {
        $Digest = (Get-FileHash -LiteralPath $Receipt -Algorithm SHA256).Hash.ToLowerInvariant()
        & $Node scripts/ci/windows-files-process.mjs publish $Root $Receipt $Digest
        if ($LASTEXITCODE -ne 0) { throw 'Fresh publication process failed.' }
        $Scope = 'private custody and publication'
        if (Test-Path -LiteralPath cli/test/windows-journey.mjs) {
            # A private setup-node executable copy is a synthetic custody fixture,
            # not proof of public runtime acquisition or distribution provenance.
            $RuntimeDirectory = [IO.Path]::Combine($Root, 'runtime')
            $null = [IO.Directory]::CreateDirectory($RuntimeDirectory, $Acl)
            $Runtime = [IO.Path]::Combine($RuntimeDirectory, 'node.exe')
            [IO.File]::Copy($Node, $Runtime, $false)
            if ((Get-FileHash -LiteralPath $Runtime).Hash -cne (Get-FileHash -LiteralPath $Node).Hash) { throw 'Runtime fixture copy differs.' }
            foreach ($Step in @('lease', 'context', 'context-replay', 'kill-context', 'recover-context', 'interrupt-install', 'install')) {
                & $Runtime cli/test/windows-journey.mjs $Step $Root $Receipt $Digest
                if ($Step -eq 'kill-context') {
                    if ($LASTEXITCODE -eq 0) { throw 'Expected abrupt context process termination.' }
                } elseif ($LASTEXITCODE -ne 0) { throw ('CLI native phase failed: ' + $Step) }
            }
            & $Shell -NoLogo -NoProfile -NonInteractive -File ([IO.Path]::Combine($Root, 'installed\obsync.ps1')) --version
            if ($LASTEXITCODE -ne 0) { throw 'Installed native launcher failed.' }
            & $Runtime cli/test/windows-journey.mjs uninstall $Root $Receipt $Digest
            if ($LASTEXITCODE -ne 0 -or [IO.Directory]::Exists([IO.Path]::Combine($Root, 'installed'))) { throw 'Exact uninstall failed.' }
            $Scope = 'private custody, publication, context recovery and installation'
        }
        Write-Output ([ordered]@{event='windows_files_native';result='pass';scope=$Scope} | ConvertTo-Json -Compress)
        $Keep = $true
    }
} finally {
    if (!$Keep -and [IO.Directory]::Exists($Root)) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
