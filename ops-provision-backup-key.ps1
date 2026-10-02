# Local recovery-key provisioning. Never emits the key or exception details.
param([switch]$ReplaceCurrentSynthetic, [byte[]]$ExpectedCurrentBytes)
$ErrorActionPreference = 'Stop'
$lock = $null
$temporary = $null
$bytes = $null
$success = $false
$stage = 'preflight'
try {
  $root = [IO.Path]::GetFullPath($PSScriptRoot)
  $ancestor = Get-Item -LiteralPath $root -Force
  while ($null -ne $ancestor) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe path' }
    $ancestor = $ancestor.Parent
  }
  $target = Join-Path $root '.env.local'
  $lockPath = Join-Path $root '.env.local.provision.lock'
  $marker = '# RESQ_BACKUP_KEY_RANDOM_V1'
  $synthetic = '# DISCLOSED CHAT VALUE: synthetic local verification only; NOT a production backup key.'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  function Assert-PrivateAcl([string]$file) {
    $acl = Get-Acl -LiteralPath $file
    if (!$acl.AreAccessRulesProtected) { throw 'unprotected ACL' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
        $rules[0].AccessControlType -ne 'Allow' -or $rules[0].IsInherited -or
        $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'unsafe ACL' }
  }
  function Set-PrivateAcl([string]$file) {
    try { Assert-PrivateAcl $file; return } catch { }
    $acl = Get-Acl -LiteralPath $file
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unexpected owner' }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
      $acl.RemoveAccessRuleSpecific($existing)
    }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $file -AclObject $acl
    Assert-PrivateAcl $file
  }
  $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw 'missing authorized input' }
  if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe file' }
  $stage = 'protect-existing'
  Set-PrivateAcl $target
  $original = [IO.File]::ReadAllText($target)
  $originalBytes = [IO.File]::ReadAllBytes($target)
  $utf8 = New-Object Text.UTF8Encoding($false, $true)
  if ([Convert]::ToBase64String($utf8.GetBytes($original)) -cne [Convert]::ToBase64String($originalBytes)) { throw 'unsupported encoding' }
  $lines = @($original -split '\r?\n')
  foreach ($line in $lines) {
    if ($line -match '^\s*(#.*)?$') { continue }
    # Deliberately support only unquoted, single-line assignments; no dotenv eval.
    if ($line -notmatch '^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=[^"\x27\r\n]*$') { throw 'unsupported env syntax' }
  }
  $assignments = @($lines | Where-Object { $_ -match '^\s*(?:export\s+)?RESQ_BACKUP_SEAL_PASSPHRASE\s*=' })
  if ($assignments.Count -ne 1) { throw 'ambiguous key' }
  $markers = @($lines | Where-Object { $_ -ceq $marker })
  $stage = 'validate-state'
  $reused = $false
  if ($markers.Count -eq 1) {
    if ($assignments[0] -cnotmatch '^RESQ_BACKUP_SEAL_PASSPHRASE=([a-f0-9]{64})$') { throw 'invalid persisted state' }
    $key = $Matches[1]
    $reused = $true
  } elseif ($ReplaceCurrentSynthetic -and $markers.Count -eq 0 -and $lines -ccontains $synthetic) {
    if ($null -eq $ExpectedCurrentBytes -or
        [Convert]::ToBase64String($ExpectedCurrentBytes) -cne [Convert]::ToBase64String($originalBytes)) { throw 'approval state changed' }
    if ($original.IndexOf($synthetic) -ne $original.LastIndexOf($synthetic) -or
        $original.IndexOf($assignments[0]) -ne $original.LastIndexOf($assignments[0])) { throw 'ambiguous replacement' }
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $key = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    $content = $original.Replace($synthetic, $marker).Replace($assignments[0], 'RESQ_BACKUP_SEAL_PASSPHRASE=' + $key)
    $temporary = Join-Path $root ('.env.local.random.tmp-' + [Guid]::NewGuid().ToString('N'))
    $empty = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $empty.Dispose()
    $stage = 'protect-temporary'
    Set-PrivateAcl $temporary
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $encoded = (New-Object Text.UTF8Encoding($false)).GetBytes($content)
      $stream.Write($encoded, 0, $encoded.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose(); if ($null -ne $encoded) { [Array]::Clear($encoded, 0, $encoded.Length) } }
    $stage = 'atomic-replacement'
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) -cne [Convert]::ToBase64String($originalBytes)) { throw 'concurrent change' }
    [IO.File]::Replace($temporary, $target, [System.Management.Automation.Language.NullString]::Value)
    $temporary = $null
  } else { throw 'unexpected existing key' }
  $stage = 'readback'
  Assert-PrivateAcl $target
  $persisted = [IO.File]::ReadAllText($target)
  $expected = if ($reused) { $original } else { $content }
  if ($persisted -cne $expected) { throw 'complete readback failed' }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) -cne [Convert]::ToBase64String($utf8.GetBytes($expected))) { throw 'byte readback failed' }
  $match = [regex]::Match($persisted, '(?m)^RESQ_BACKUP_SEAL_PASSPHRASE=([a-f0-9]{64})\r?$')
  if (!$match.Success -or $match.Groups[1].Value -cne $key) { throw 'readback failed' }
  [Environment]::SetEnvironmentVariable('RESQ_BACKUP_SEAL_PASSPHRASE', $key, 'Process')
  $success = $true
} catch {
  $success = $false
} finally {
  if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  try { if ($null -ne $lock) { $lock.Dispose(); [IO.File]::Delete($lockPath) } }
  catch { $success = $false; $stage = 'lock-cleanup' }
  # Retain any private temporary artifact after failure; never delete the original.
  $key = $null; $original = $null; $persisted = $null; $content = $null
}
if ($success) {
  @{available=$true; persistedReadbackVerified=$true; privateAclVerified=$true; reused=$reused} | ConvertTo-Json -Compress
} else { @{provisioningSucceeded=$false; stage=$stage} | ConvertTo-Json -Compress }
if (!$success) { exit 1 }
