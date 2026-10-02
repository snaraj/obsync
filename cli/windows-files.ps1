# The only client native interop surface. See AGENTS.md requirement 5.
# Fixed source; request data arrives on stdin. Never dot-source this file.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)

function Refuse([string] $Reason) { throw [InvalidOperationException]::new($Reason) }
function Exact-Path([string] $Path) {
    if ($Path.Length -lt 4 -or $Path.Length -gt 240 -or $Path -cnotmatch '^[A-Z]:\\' -or
        $Path -match '[\x00-\x1f\x7f/<>"|?*]' -or $Path.Substring(2).Contains(':') -or
        $Path.EndsWith('\') -or [IO.Path]::GetFullPath($Path) -cne $Path) { Refuse 'path_spelling' }
    foreach ($Part in $Path.Substring(3).Split('\')) {
        if (!$Part -or $Part -eq '.' -or $Part -eq '..' -or $Part -match '[ .]$' -or
            $Part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { Refuse 'path_spelling' }
    }
    $Drive = [IO.DriveInfo]::new($Path.Substring(0, 3))
    if (!$Drive.IsReady -or $Drive.DriveType -ne 'Fixed' -or $Drive.DriveFormat -cne 'NTFS') { Refuse 'local_ntfs_required' }
}

$User = [Security.Principal.WindowsIdentity]::GetCurrent().User
$Trusted = @($User.Value, 'S-1-5-18', 'S-1-5-32-544')
$Installer = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$Access = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
$Mutate = [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership

function Inspect-One([string] $Path, [bool] $Private, [bool] $OsCode = $false) {
    $Attributes = [IO.File]::GetAttributes($Path)
    if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'reparse_point' }
    $Directory = ($Attributes -band [IO.FileAttributes]::Directory) -ne 0
    $Acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path, $Access) } else { [IO.File]::GetAccessControl($Path, $Access) }
    $Owner = $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $Allowed = if ($OsCode -or !$Private) { $Trusted + $Installer } else { $Trusted }
    if ($Owner -notin $Allowed -or ($Private -and $Owner -cne $User.Value)) { Refuse 'owner' }
    $Own = $false
    foreach ($Rule in $Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if (($Rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($Rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $Sid = $Rule.IdentityReference.Value
        if ($Sid -eq $User.Value -and ($Rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $Own = $true }
        if ($Sid -notin $Allowed -and ($Private -or ($Rule.FileSystemRights -band $Mutate) -ne 0)) { Refuse 'acl_access' }
    }
    if ($Private -and !$Own) { Refuse 'owner_access' }
    return $Directory
}

function Inspect-Parents([string] $Path, [bool] $OsCode = $false) {
    $At = [IO.Path]::GetDirectoryName($Path)
    while ($At) {
        if (!(Inspect-One $At $false $OsCode)) { Refuse 'ancestor_directory' }
        $Parent = [IO.Directory]::GetParent($At)
        $At = if ($null -eq $Parent) { $null } else { $Parent.FullName }
    }
}

function Private-Acl([bool] $Directory) {
    $Acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $Acl.SetOwner($User)
    $Acl.SetAccessRuleProtection($true, $false)
    $Inheritance = if ($Directory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($Sid in $Trusted) {
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($Sid), [Security.AccessControl.FileSystemRights]::FullControl,
            $Inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $Acl.AddAccessRule($Rule)
    }
    return $Acl
}

function Flush-File([string] $Path) {
    $File = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $File.Flush($true) } finally { $File.Dispose() }
}

function Flush-Tree([string] $Root) {
    $Pending = [Collections.Generic.Stack[string]]::new()
    $Pending.Push($Root)
    $Count = 0
    $Queued = 1
    while ($Pending.Count -gt 0) {
        $At = $Pending.Pop()
        if (++$Count -gt 100000) { Refuse 'tree_budget' }
        Exact-Path $At
        if (Inspect-One $At $true) {
            foreach ($Child in [IO.Directory]::EnumerateFileSystemEntries($At)) {
                if (++$Queued -gt 100000) { Refuse 'tree_budget' }
                $Pending.Push($Child)
            }
        } else { Flush-File $At }
    }
}

try {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or ![Environment]::Is64BitProcess) { Refuse 'os_powershell_required' }
    $Executable = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\powershell.exe')
    if ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ine $Executable) { Refuse 'os_powershell_required' }
    Inspect-Parents $Executable $true
    if (Inspect-One $Executable $false $true) { Refuse 'os_powershell_required' }
    $Characters = [char[]]::new(16385)
    $Count = 0
    while ($Count -lt $Characters.Length) {
        $Read = [Console]::In.Read($Characters, $Count, $Characters.Length - $Count)
        if ($Read -eq 0) { break }
        $Count += $Read
    }
    if ($Count -gt 16384) { Refuse 'request_budget' }
    $Raw = [string]::new($Characters, 0, $Count).TrimEnd([char[]]@("`r", "`n"))
    $Request = ConvertFrom-Json -InputObject $Raw
    $Names = @($Request.PSObject.Properties.Name)
    if ($Names.Count -ne 4 -or @($Names | Where-Object { $_ -cnotin @('v', 'op', 'path', 'destination') }).Count -ne 0 -or
        $Request.v -isnot [int] -or $Request.v -ne 1 -or $Request.op -isnot [string] -or
        $Request.path -isnot [string] -or $Request.destination -isnot [string] -or
        $Request.op -cnotin @('setup', 'inspect', 'mkdir', 'create', 'flush', 'publish')) { Refuse 'request_shape' }
    if (($Request | ConvertTo-Json -Compress -Depth 2) -cne $Raw) { Refuse 'request_spelling' }
    Exact-Path $Request.path
    Inspect-Parents $Request.path
    if ($Request.op -ne 'publish' -and $Request.destination -cne '') { Refuse 'request_shape' }
    switch -CaseSensitive ($Request.op) {
        'setup' {
            if ([IO.File]::Exists($Request.path) -or [IO.Directory]::Exists($Request.path)) { Refuse 'destination_exists' }
            $null = [IO.Directory]::CreateDirectory($Request.path, (Private-Acl $true))
            $null = Inspect-One $Request.path $true
            $Receipt = [IO.Path]::Combine($Request.path, 'powershell.json')
            Exact-Path $Receipt
            $Hash = [Security.Cryptography.SHA256]::Create()
            $Code = [IO.File]::OpenRead($Executable)
            try { $Digest = [BitConverter]::ToString($Hash.ComputeHash($Code)).Replace('-', '').ToLowerInvariant() }
            finally { $Code.Dispose(); $Hash.Dispose() }
            $Bytes = [Text.Encoding]::UTF8.GetBytes(([ordered]@{schema_version=1;directory=$Request.path;powershell=[ordered]@{path=$Executable;sha256=$Digest}} | ConvertTo-Json -Compress))
            $File = [IO.FileStream]::new($Receipt, [IO.FileMode]::CreateNew,
                [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write,
                [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, (Private-Acl $false))
            try { $File.Write($Bytes, 0, $Bytes.Length); $File.Flush($true) } finally { $File.Dispose() }
            $null = Inspect-One $Receipt $true
        }
        'inspect' { $null = Inspect-One $Request.path $true }
        'mkdir' {
            if ([IO.File]::Exists($Request.path) -or [IO.Directory]::Exists($Request.path)) { Refuse 'destination_exists' }
            $null = [IO.Directory]::CreateDirectory($Request.path, (Private-Acl $true))
            if (!(Inspect-One $Request.path $true)) { Refuse 'directory_required' }
        }
        'create' {
            if (!(Inspect-One ([IO.Path]::GetDirectoryName($Request.path)) $true)) { Refuse 'private_parent' }
            $File = [IO.FileStream]::new($Request.path, [IO.FileMode]::CreateNew,
                [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write,
                [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, (Private-Acl $false))
            try { $File.Flush($true) } finally { $File.Dispose() }
            if (Inspect-One $Request.path $true) { Refuse 'file_required' }
        }
        'flush' {
            if (Inspect-One $Request.path $true) { Refuse 'file_required' }
            Flush-File $Request.path
        }
        'publish' {
            Exact-Path $Request.destination
            Inspect-Parents $Request.destination
            if ([IO.Path]::GetDirectoryName($Request.path) -cne [IO.Path]::GetDirectoryName($Request.destination) -or
                !(Inspect-One $Request.path $true)) { Refuse 'same_parent_directory_required' }
            if ([IO.File]::Exists($Request.destination) -or [IO.Directory]::Exists($Request.destination)) { Refuse 'destination_exists' }
            Flush-Tree $Request.path
            $Assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
                [Reflection.AssemblyName]::new('ObsyncDirectoryPublication'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
            $Module = $Assembly.DefineDynamicModule('ObsyncDirectoryPublication')
            $Method = $Module.DefinePInvokeMethod('MoveFileExW', 'kernel32.dll', 'MoveFileExW',
                [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl,
                [Reflection.CallingConventions]::Standard, [bool], [Type[]]@([string], [string], [uint32]),
                [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
            $Import = [Runtime.InteropServices.DllImportAttribute]
            $Method.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new(
                $Import.GetConstructor([Type[]]@([string])), [object[]]@('kernel32.dll'),
                [Reflection.FieldInfo[]]@($Import.GetField('EntryPoint'), $Import.GetField('ExactSpelling'), $Import.GetField('SetLastError'), $Import.GetField('CharSet')),
                [object[]]@('MoveFileExW', $true, $true, [Runtime.InteropServices.CharSet]::Unicode)))
            $Method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
            $Module.CreateGlobalFunctions()
            if (!$Module.GetMethod('MoveFileExW').Invoke($null, [object[]]@($Request.path, $Request.destination, [uint32]0x8))) { Refuse 'publication_io' }
            if (!(Inspect-One $Request.destination $true)) { Refuse 'publication_readback' }
        }
    }
    [Console]::Out.WriteLine('{"v":1,"ok":true}')
    exit 0
} catch {
    [Console]::Error.WriteLine('{"v":1,"ok":false,"reason":"windows_files_refused"}')
    exit 4
}
