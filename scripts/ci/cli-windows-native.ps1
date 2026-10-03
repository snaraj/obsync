# Hosted disposable Windows runner only. No production paths or credentials.
param([switch]$SelectedUser, [switch]$Peer, [string]$Python, [string]$Package, [string]$Phase, [string]$Root)
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
    $Python = (Get-Command python -CommandType Application | Select-Object -First 1).Source
    $Package = [IO.Path]::GetFullPath($Package)
    if (![IO.File]::Exists([IO.Path]::Combine($Package, 'obsync.exe'))) { throw 'Native package required.' }
    $Accounts = @()
    $Handoff = $null
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
        # The builder's private files belong to the runner. Give only the
        # selected recipient read access to a separate, byte-verified copy.
        $Handoff = [IO.Path]::Combine($env:RUNNER_TEMP, 'obsync handoff ' + [Guid]::NewGuid().ToString('N'))
        $HandoffAcl = [Security.AccessControl.DirectorySecurity]::new()
        $HandoffAcl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
        $HandoffAcl.SetAccessRuleProtection($true, $false)
        foreach ($Sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            $HandoffAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($Sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        }
        $HandoffAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $Accounts[0].SID, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        $null = [IO.Directory]::CreateDirectory($Handoff, $HandoffAcl)
        foreach ($Name in @('LICENSE', 'README.md', 'VERSION', 'obsync.exe', 'package-manifest.json')) {
            $Source = [IO.Path]::Combine($Package, $Name)
            $Destination = [IO.Path]::Combine($Handoff, $Name)
            [IO.File]::Copy($Source, $Destination, $false)
            if ((Get-FileHash -LiteralPath $Source).Hash -cne (Get-FileHash -LiteralPath $Destination).Hash) { throw 'Handoff package copy differs.' }
        }
        $Package = $Handoff
        $Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -SelectedUser -Python "' + $Python + '" -Package "' + $Package + '"'
        $Prepared = Invoke-Owned $Accounts[0] $Passwords[0] ($Arguments + ' -Phase prepare')
        Write-Output '{"event":"windows_package_handoff","result":"pass","scope":"verified private copy read by the selected ordinary user"}'
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
        if ($Handoff -and [IO.Directory]::Exists($Handoff)) { Remove-Item -LiteralPath $Handoff -Recurse -Force }
        if ($Root -and [IO.Directory]::Exists($Root)) { Remove-Item -LiteralPath $Root -Recurse -Force }
        foreach ($Account in $Accounts) {
            Get-CimInstance Win32_UserProfile -Filter ("SID='" + $Account.SID.Value + "'") | Remove-CimInstance
            Remove-LocalUser -SID $Account.SID
        }
    }
    exit 0
}
if (![IO.Path]::IsPathRooted($Python) -or ![IO.File]::Exists($Python)) { throw 'CI Python tool path required.' }
if (![IO.Path]::IsPathRooted($Package) -or ![IO.Directory]::Exists($Package)) { throw 'Native package required.' }
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
        $OwnedPackage = [IO.Path]::Combine($Root, 'package')
        $null = [IO.Directory]::CreateDirectory($OwnedPackage, $Acl)
        foreach ($Name in @('LICENSE', 'README.md', 'VERSION', 'obsync.exe', 'package-manifest.json')) {
            [IO.File]::Copy([IO.Path]::Combine($Package, $Name), [IO.Path]::Combine($OwnedPackage, $Name), $false)
            if ((Get-FileHash -LiteralPath ([IO.Path]::Combine($Package, $Name))).Hash -cne
                (Get-FileHash -LiteralPath ([IO.Path]::Combine($OwnedPackage, $Name))).Hash) { throw 'Fixture package copy differs.' }
        }
        $PlanText = & ([IO.Path]::Combine($OwnedPackage, 'obsync.exe')) windows-setup -o json
        if ($LASTEXITCODE -ne 0) { throw 'Public setup instructions failed.' }
        $Plan = $PlanText | ConvertFrom-Json
        if ($Plan.schema_version -ne 1 -or $Plan.operation -cne 'cli.windows_setup' -or
            $Plan.state -cne 'completed' -or $Plan.data.script -isnot [string]) { throw 'Public setup instructions differ.' }
        $SetupText = & ([ScriptBlock]::Create($Plan.data.script))
        if ($SetupText -isnot [string]) { throw 'Public setup must return one JSON receipt.' }
        $Setup = $SetupText | ConvertFrom-Json
        if ($Setup.v -ne 1 -or $Setup.path -isnot [string] -or $Setup.digest -cnotmatch '^[a-f0-9]{64}$') { throw 'Public setup receipt differs.' }
        [IO.File]::WriteAllText($SetupRecord, ($Setup | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        $Stage = [IO.Path]::Combine($Root, 'stage')
        $null = [IO.Directory]::CreateDirectory($Stage, $Acl)
        [IO.File]::WriteAllText([IO.Path]::Combine($Stage, 'sentinel.txt'), 'synthetic custody fixture')
        $Keep = $true
        Write-Output ([ordered]@{event='fixture_ready';root=$Root} | ConvertTo-Json -Compress)
    } else {
        $Setup = [IO.File]::ReadAllText($SetupRecord) | ConvertFrom-Json
        $Receipt = $Setup.path
        $Digest = $Setup.digest
        if ((Get-FileHash -LiteralPath $Receipt -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Digest) { throw 'Setup receipt changed.' }
        & $Python scripts/ci/cli-native.py --package ([IO.Path]::Combine($Root, 'package')) --root $Root `
            --receipt ([IO.Path]::Combine($Root, 'acceptance.json')) --windows-trust $Receipt --windows-trust-sha256 $Digest
        if ($LASTEXITCODE -ne 0) { throw 'Native packaged CLI journey failed.' }
        Write-Output '{"event":"windows_files_native","result":"pass","scope":"ordinary-user native Rust installation, context receipts, replay and uninstall"}'
        $TrustRoot = [IO.Path]::GetDirectoryName($Receipt)
        if ([IO.Path]::GetFileName($TrustRoot) -cnotmatch '^obsync-cli-[a-f0-9]{32}$' -or
            [IO.Path]::GetDirectoryName($TrustRoot) -cne [Environment]::GetFolderPath('LocalApplicationData')) { throw 'Trust cleanup binding differs.' }
        Remove-Item -LiteralPath $TrustRoot -Recurse -Force
        $Keep = $true
    }
} finally {
    if (!$Keep -and [IO.Directory]::Exists($Root)) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
