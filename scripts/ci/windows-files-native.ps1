# Hosted disposable Windows runner only. No production paths or credentials.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows') { throw 'Hosted Windows runner required.' }
$Shell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\powershell.exe')
$Node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
if ((& $Node --version) -cne 'v26.10.0') { throw 'Pinned runtime required.' }
$User = [Security.Principal.WindowsIdentity]::GetCurrent().User
$Root = [IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), 'obsync native ' + [Guid]::NewGuid().ToString('N'))
$Acl = [Security.AccessControl.DirectorySecurity]::new()
$Acl.SetOwner($User)
$Acl.SetAccessRuleProtection($true, $false)
foreach ($Sid in @($User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($Sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
$null = [IO.Directory]::CreateDirectory($Root, $Acl)
$Name = 'ob' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
$Created = $false
try {
    $Trust = [IO.Path]::Combine($Root, 'trust')
    [ordered]@{v=1;op='setup';path=$Trust;destination=''} | ConvertTo-Json -Compress | & $Shell -NoLogo -NoProfile -NonInteractive -File cli/windows-files.ps1
    if ($LASTEXITCODE -ne 0) { throw 'Trusted OS setup failed.' }
    $Receipt = [IO.Path]::Combine($Trust, 'powershell.json')
    $Digest = (Get-FileHash -LiteralPath $Receipt -Algorithm SHA256).Hash.ToLowerInvariant()
    & $Node scripts/ci/windows-files-process.mjs prepare $Root $Receipt $Digest
    if ($LASTEXITCODE -ne 0) { throw 'Prepare process failed.' }
    $Password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
    $null = New-LocalUser -Name $Name -Password $Password -AccountNeverExpires
    $Created = $true
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $Name
    $Credential = [Management.Automation.PSCredential]::new('.\' + $Name, $Password)
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
    }
    Write-Output '{"event":"windows_files_native","result":"pass","scope":"primitive custody and publication only"}'
} finally {
    if ($Created) { Remove-LocalUser -Name $Name }
    # Root is the exact private path created above, never a caller input.
    if ([IO.Directory]::Exists($Root)) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
