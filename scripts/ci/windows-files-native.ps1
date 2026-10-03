# Hosted disposable Windows runner only. No production paths or credentials.
param([switch]$SelectedUser, [string]$Node)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows') { throw 'Hosted Windows runner required.' }
$Shell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\powershell.exe')
if (!$SelectedUser) {
    $Node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    if ((& $Node --version) -cne 'v26.10.0' -or $LASTEXITCODE -ne 0) { throw 'Controller runtime differs.' }
    $Accounts = @()
    try {
        $Passwords = @(([Guid]::NewGuid().ToString('N') + 'aA1!'), ([Guid]::NewGuid().ToString('N') + 'aA1!'))
        for ($Index = 0; $Index -lt 2; $Index++) {
            $Name = 'ob' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
            $Account = New-LocalUser -Name $Name -Password (ConvertTo-SecureString $Passwords[$Index] -AsPlainText -Force) -AccountNeverExpires
            $Accounts += $Account
            Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $Name
        }
        # Only this controller is elevated. Product operations run with an
        # ordinary user's token, whose default file owner is that user.
        $Start = [Diagnostics.ProcessStartInfo]::new($Shell)
        $Start.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -SelectedUser -Node "' + $Node + '"'
        $Start.WorkingDirectory = (Get-Location).Path
        $Start.UseShellExecute = $false
        $Start.UserName = $Accounts[0].Name
        $Start.Domain = '.'
        $Start.Password = ConvertTo-SecureString $Passwords[0] -AsPlainText -Force
        $Start.LoadUserProfile = $true
        $Start.RedirectStandardInput = $true
        # A credentialed process otherwise receives the selected account's
        # default environment, not the hosted markers. Pass only fixed data;
        # never copy runner credentials or executable-selection variables.
        $Start.EnvironmentVariables.Clear()
        $Start.EnvironmentVariables['GITHUB_ACTIONS'] = 'true'
        $Start.EnvironmentVariables['RUNNER_OS'] = 'Windows'
        # PowerShell classifies even explicit .exe paths using PATHEXT.
        $Start.EnvironmentVariables['PATHEXT'] = '.EXE'
        $Start.EnvironmentVariables['SystemRoot'] = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
        $Start.EnvironmentVariables['PSModulePath'] = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\Modules')
        $BeforeEncoding = [Console]::InputEncoding
        try {
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
            $Child = [Diagnostics.Process]::Start($Start)
        } finally { [Console]::InputEncoding = $BeforeEncoding }
        try {
            # Synthetic peer credentials travel only through this owned pipe.
            $Child.StandardInput.WriteLine($Accounts[1].Name)
            $Child.StandardInput.WriteLine($Passwords[1])
            $Child.StandardInput.Close()
            if (!$Child.WaitForExit(180000)) { $Child.Kill(); $Child.WaitForExit(); throw 'Native selected-user journey timed out.' }
            if ($Child.ExitCode -ne 0) { throw 'Native selected-user journey failed.' }
        } finally { $Child.Dispose() }
    } finally {
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
$Name = [Console]::In.ReadLine()
$PeerPassword = [Console]::In.ReadLine()
if ($Name -cnotmatch '^ob[a-f0-9]{14}$' -or $PeerPassword -cnotmatch '^[a-f0-9]{32}aA1!$') { throw 'Invalid owned peer fixture.' }
$Credential = [Management.Automation.PSCredential]::new('.\' + $Name, (ConvertTo-SecureString $PeerPassword -AsPlainText -Force))
$Root = [IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), 'obsync native ' + [Guid]::NewGuid().ToString('N'))
$Acl = [Security.AccessControl.DirectorySecurity]::new()
$Acl.SetOwner($User)
$Acl.SetAccessRuleProtection($true, $false)
foreach ($Sid in @($User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($Sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
$null = [IO.Directory]::CreateDirectory($Root, $Acl)
try {
    $Trust = [IO.Path]::Combine($Root, 'trust')
    $RequestText = [ordered]@{v=1;op='setup';path=$Trust;destination=''} | ConvertTo-Json -Compress
    $Request = [Text.UTF8Encoding]::new($false, $true).GetBytes($RequestText)
    # Use an explicit UTF-8 byte pipe, as the Node adapter does. PowerShell's
    # object pipeline must not choose serialization for this JSON protocol.
    $Start = [Diagnostics.ProcessStartInfo]::new($Shell)
    $Start.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + [IO.Path]::GetFullPath('cli/windows-files.ps1') + '"'
    $Start.UseShellExecute = $false
    $Start.RedirectStandardInput = $true
    # .NET Framework chooses this encoding when constructing the child's
    # stdin writer. Its default UTF-8 preamble would precede the raw JSON.
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
    $Receipt = [IO.Path]::Combine($Trust, 'powershell.json')
    $Digest = (Get-FileHash -LiteralPath $Receipt -Algorithm SHA256).Hash.ToLowerInvariant()
    & $Node scripts/ci/windows-files-process.mjs prepare $Root $Receipt $Digest
    if ($LASTEXITCODE -ne 0) { throw 'Prepare process failed.' }
    $Sentinel = [IO.Path]::Combine($Root, 'stage\sentinel.txt').Replace("'", "''")
    $Stage = [IO.Path]::Combine($Root, 'stage').Replace("'", "''")
    # A second ordinary account independently attempts list, read and replace.
    # The only possible success exit is three actual UnauthorizedAccess errors.
    $Probe = @"
`$ErrorActionPreference = 'Stop'; `$Denied = 0
try { [IO.Directory]::GetFileSystemEntries('$Stage') | Out-Null } catch [UnauthorizedAccessException] { `$Denied++ }
try { [IO.File]::ReadAllText('$Sentinel') | Out-Null } catch [UnauthorizedAccessException] { `$Denied++ }
try { [IO.File]::WriteAllText('$Sentinel', 'changed') } catch [UnauthorizedAccessException] { `$Denied++ }
if (`$Denied -ne 3) { exit 7 }; exit 0
"@
    $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Probe))
    $Process = Start-Process -FilePath $Shell -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $Encoded) -Credential $Credential -WorkingDirectory ([Environment]::SystemDirectory) -Wait -PassThru
    if ($Process.ExitCode -ne 0) { throw 'Independent account custody failed.' }
    & $Node scripts/ci/windows-files-process.mjs publish $Root $Receipt $Digest
    if ($LASTEXITCODE -ne 0) { throw 'Fresh publication process failed.' }
    $Scope = 'private custody and publication'
    if (Test-Path -LiteralPath cli/test/windows-journey.mjs) {
        # This private copy is a synthetic custody fixture of setup-node's
        # pinned executable. It is not public runtime acquisition evidence.
        $RuntimeDirectory = [IO.Path]::Combine($Root, 'runtime')
        $null = [IO.Directory]::CreateDirectory($RuntimeDirectory, $Acl)
        $Runtime = [IO.Path]::Combine($RuntimeDirectory, 'node.exe')
        [IO.File]::Copy($Node, $Runtime, $false)
        if ((Get-FileHash -LiteralPath $Runtime).Hash -cne (Get-FileHash -LiteralPath $Node).Hash) { throw 'Runtime fixture copy differs.' }
        foreach ($Phase in @('context', 'context-replay', 'kill-context', 'recover-context', 'install')) {
            & $Runtime cli/test/windows-journey.mjs $Phase $Root $Receipt $Digest
            if ($Phase -eq 'kill-context') {
                if ($LASTEXITCODE -eq 0) { throw 'Expected abrupt context process termination.' }
            } elseif ($LASTEXITCODE -ne 0) { throw ('CLI native phase failed: ' + $Phase) }
        }
        & $Shell -NoLogo -NoProfile -NonInteractive -File ([IO.Path]::Combine($Root, 'installed\obsync.ps1')) --version
        if ($LASTEXITCODE -ne 0) { throw 'Installed native launcher failed.' }
        & $Runtime cli/test/windows-journey.mjs uninstall $Root $Receipt $Digest
        if ($LASTEXITCODE -ne 0 -or [IO.Directory]::Exists([IO.Path]::Combine($Root, 'installed'))) { throw 'Exact uninstall failed.' }
        $Scope = 'private custody, publication, context recovery and installation'
    }
    Write-Output ([ordered]@{event='windows_files_native';result='pass';scope=$Scope} | ConvertTo-Json -Compress)
} finally {
    # Root is the exact private path created above, never a caller input.
    if ([IO.Directory]::Exists($Root)) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
