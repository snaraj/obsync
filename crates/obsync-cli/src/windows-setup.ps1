# Run in an independently opened, trusted OS PowerShell 5.1 session.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or ![Environment]::Is64BitProcess) { throw 'OS PowerShell 5.1 required' }
$e = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\powershell.exe')
if ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ine $e) { throw 'Trusted OS PowerShell session required' }
$d = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'obsync-cli-' + [Guid]::NewGuid().ToString('N'))
$p = [Diagnostics.ProcessStartInfo]::new($e)
$p.Arguments = __HELPER_ARGUMENTS__
$p.UseShellExecute = $false
$p.RedirectStandardInput = $true
$p.RedirectStandardOutput = $true
$p.RedirectStandardError = $true
$p.EnvironmentVariables.Clear()
$p.EnvironmentVariables['SystemRoot'] = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
$p.EnvironmentVariables['PSModulePath'] = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\Modules')
$old = [Console]::InputEncoding
try {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
    $c = [Diagnostics.Process]::Start($p)
} finally { [Console]::InputEncoding = $old }
try {
    $out = $c.StandardOutput.ReadToEndAsync()
    $err = $c.StandardError.ReadToEndAsync()
    $c.StandardInput.Write('{"v":1,"id":1,"op":"setup","path":"' + $d.Replace('\', '\\') + '","destination":""}')
    $c.StandardInput.Close()
    if (!$c.WaitForExit(15000)) { $c.Kill(); $c.WaitForExit(); throw 'Setup deadline' }
    if ($c.ExitCode -ne 0 -or $err.Result -or $out.Result.Trim() -cne '{"v":1,"id":1,"ok":true}') { throw 'Setup refused' }
} finally { $c.Dispose() }
$f = [IO.Path]::Combine($d, 'powershell.json')
$h = [Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($h.ComputeHash([IO.File]::ReadAllBytes($f))).Replace('-', '').ToLowerInvariant() }
finally { $h.Dispose() }
'{"v":1,"path":"' + $f.Replace('\', '\\') + '","digest":"' + $digest + '"}'
