# Hosted disposable Windows runner only. No production paths or credentials.
param([switch]$SelectedUser, [switch]$Peer, [string]$Node, [string]$Phase, [string]$Root)
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
        $Child = [Diagnostics.Process]::Start($Start)
        try {
            $Child.StandardInput.Close()
            $Output = $Child.StandardOutput.ReadToEndAsync()
            $Errors = $Child.StandardError.ReadToEndAsync()
            $Budget = 240000
            if (!$Child.WaitForExit($Budget)) { $Child.Kill(); $Child.WaitForExit(); throw 'Native owned process timed out.' }
            $Text = $Output.Result
            $ErrorText = $Errors.Result
            if ($Text.Length + $ErrorText.Length -gt 65536) { throw 'Native process output budget.' }
            if ($Child.ExitCode -ne 0) {
                foreach ($Line in $Text -split '\r?\n') {
                    if ($Line.StartsWith('{"event":"windows_') -or $Line.StartsWith('obsidian-drive: (')) { Write-Host $Line }
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
        $null = Invoke-Owned $Accounts[1] $Passwords[1] ('-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Peer -Root "' + $Root + '"')
        Write-Output '{"event":"windows_peer_custody","result":"pass"}'
        $Completed = Invoke-Owned $Accounts[0] $Passwords[0] ($Arguments + ' -Phase complete -Root "' + $Root + '"')
        foreach ($Line in ($Prepared + "`n" + $Completed) -split '\r?\n') {
            if ($Line.StartsWith('{') -and !$Line.StartsWith('{"event":"fixture_ready",')) { Write-Output $Line }
        }
    } finally {
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
} elseif ($Phase -cnotin @('complete') -or !$Root -or [IO.Path]::GetDirectoryName($Root) -cne $Profile -or
    [IO.Path]::GetFileName($Root) -cnotmatch '^obsync native [a-f0-9]{32}$') { throw 'Invalid owned fixture phase.' }
$Keep = $false
try {
    $SetupRecord = [IO.Path]::Combine($Root, 'setup-receipt.json')
    if ($Phase -ceq 'prepare') {
        # The same public ceremony printed in the shipped README. The verified
        # package emits fixed helper code; the selected user runs it in OS PowerShell.
        $PlanText = & $Node cli/dist/cli/install.mjs windows-setup
        if ($LASTEXITCODE -ne 0) { throw 'Public setup plan failed.' }
        $Plan = $PlanText | ConvertFrom-Json
        if ($Plan.schema_version -ne 1 -or $Plan.operation -cne 'cli.windows_setup' -or
            $Plan.state -cne 'needs_action' -or $Plan.command -isnot [string]) { throw 'Public setup plan differs.' }
        $SetupText = & ([ScriptBlock]::Create($Plan.command))
        if ($SetupText -isnot [string]) { throw 'Public setup must return one JSON receipt through the pipeline.' }
        $Setup = $SetupText | ConvertFrom-Json
        if ($Setup.v -ne 1 -or $Setup.path -isnot [string] -or $Setup.digest -cnotmatch '^[a-f0-9]{64}$') { throw 'Public setup receipt differs.' }
        $Receipt = $Setup.path
        $Digest = $Setup.digest
        [IO.File]::WriteAllText($SetupRecord, ($Setup | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        & $Node scripts/ci/cli-windows-files.mjs prepare $Root $Receipt $Digest
        if ($LASTEXITCODE -ne 0) { throw 'Prepare process failed.' }
        $Keep = $true
        Write-Output ([ordered]@{event='fixture_ready';root=$Root} | ConvertTo-Json -Compress)
    } else {
        $Setup = [IO.File]::ReadAllText($SetupRecord) | ConvertFrom-Json
        $Receipt = $Setup.path
        $Digest = $Setup.digest
        if ((Get-FileHash -LiteralPath $Receipt -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Digest) { throw 'Setup receipt changed.' }
        & $Node scripts/ci/cli-windows-files.mjs publish $Root $Receipt $Digest
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
            foreach ($Step in @('interrupt-mkdir', 'lease', 'context', 'context-replay', 'kill-context', 'recover-context', 'interrupt-install', 'install', 'launch-guards', 'public-context', 'startup')) {
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
