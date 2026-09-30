# acl-watch.ps1 - READ-ONLY ACL check for the listener store (t192u). Changes nothing: no Set-Acl, no icacls grant/remove.
# Run by hand every 12 h and after every Codex update/reinstall (security condition B):
#   powershell -NoProfile -File acl-watch.ps1 -Path C:\Users\User\AppData\Local\resq-listeners
# Folder (-Path is a directory): the folder must be owned by the account, have inheritance OFF, and every ACE on it and on
#   its direct children must belong to the account, SYSTEM or Administrators.
# File (-Path is a file): same principal/owner rule. A file with inheritance ON is fine only when it inherits from a parent
#   folder that itself passes the folder rule (protected, owned by the account, allowed principals only).
# Exit 0 = clean, 2 = violation, 3 = path missing. No scheduled task, no autostart.
param([string]$Path = (Join-Path $env:LOCALAPPDATA 'resq-listeners'))
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path)) { Write-Output "MISSING $Path"; exit 3 }
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($me, 'S-1-5-18', 'S-1-5-32-544')   # the account, LocalSystem, BUILTIN\Administrators
function Sid-Of([string]$name) {
  try { return (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
  catch { return $name }   # unresolvable: compared as-is (never allowed)
}
# Returns a list of problems for one item. $mustBeProtected: folder rule (inheritance must be OFF).
function Check-Item($item, [bool]$mustBeProtected) {
  $problems = @()
  $acl = Get-Acl -LiteralPath $item.FullName
  $owner = Sid-Of $acl.Owner
  if ($owner -ne $me) { $problems += "$($item.Name): owner $($acl.Owner)" }
  if ($mustBeProtected -and -not $acl.AreAccessRulesProtected) { $problems += "$($item.Name): inheritance ON" }
  foreach ($r in $acl.Access) {
    $sid = Sid-Of $r.IdentityReference.Value
    if ($allowedSids -notcontains $sid) { $problems += "$($item.Name): $($r.IdentityReference.Value) $($r.AccessControlType) $($r.FileSystemRights) inherited=$($r.IsInherited)" }
  }
  return ,$problems
}
function Show($item) { & icacls $item.FullName | Where-Object { $_ -and $_ -notmatch '^Successfully processed' } | ForEach-Object { Write-Output $_ } }
Write-Output ("acl-watch " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " (IL)")
$target = Get-Item -LiteralPath $Path -Force
$bad = @()
if ($target.PSIsContainer) {
  Show $target; $bad += Check-Item $target $true
  foreach ($child in @(Get-ChildItem -LiteralPath $target.FullName -Force)) { Show $child; $bad += Check-Item $child $false }
} else {
  Show $target
  $acl = Get-Acl -LiteralPath $target.FullName
  if ($acl.AreAccessRulesProtected) { $bad += Check-Item $target $false }
  else {
    # inheritance ON: acceptable only when the parent folder itself passes the folder rule
    $parent = Get-Item -LiteralPath ([System.IO.Path]::GetDirectoryName($target.FullName)) -Force
    Show $parent
    $parentProblems = Check-Item $parent $true
    if ($parentProblems.Count) { $bad += "$($target.Name): inherits from a parent that is not locked"; $bad += $parentProblems }
    $bad += Check-Item $target $false
  }
}
if ($bad.Count) { Write-Output 'VIOLATION:'; $bad | Select-Object -Unique | ForEach-Object { Write-Output "  $_" }; exit 2 }
Write-Output 'OK: only the account/SYSTEM/Administrators; folder inheritance off (files may inherit from the locked folder)'; exit 0
