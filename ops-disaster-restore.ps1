param(
  [Parameter(Mandatory=$true)][ValidateSet('backup','verify','plan','restore','report')][string]$Command,
  [string]$Source = '',
  [string]$Set = '',
  [string]$Target = '',
  [string]$Out = '',
  [switch]$DryRun,
  [switch]$Execute,
  [string]$ConfirmTarget = ''
)
# ============================================================
#  ops-disaster-restore.ps1 - עטיפת Windows לצינור ההתאוששות
# ============================================================
#  תואם Windows PowerShell 5.1 וגם PowerShell 7: בלי ternary, בלי ??,
#  בלי -Parallel. העטיפה רק מאמתת ארגומנטים ומפעילה
#  node ops-disaster-restore.mjs - כל כללי הסירוב נאכפים בקוד ה-Node,
#  והעטיפה אינה יכולה לעקוף אותם.
#
#  ברירת המחדל היא dry-run. ביצוע אמיתי דורש -Execute וגם -ConfirmTarget
#  זהה ל--Target, וגם RESQ_RESTORE_TARGET_ALLOWLIST בסביבה.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'ops-disaster-restore.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw ('ops-disaster-restore.mjs לא נמצא ליד העטיפה: ' + $script) }
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'node לא נמצא במסלול' }

if ($DryRun -and $Execute) { throw '-DryRun ו--Execute סותרים זה את זה' }
if ($Execute -and $Command -ne 'restore' -and $Command -ne 'backup') { throw '-Execute תקף רק לפקודות backup או restore' }
if ($ConfirmTarget -ne '' -and -not $Execute) { throw '-ConfirmTarget תקף רק עם -Execute' }
if ($Execute -and $Command -eq 'restore') {
  if ($ConfirmTarget -eq '') { throw '-Execute (restore) דורש -ConfirmTarget זהה ל--Target' }
  if ($ConfirmTarget -cne $Target) { throw '-ConfirmTarget אינו זהה ל--Target - הביצוע נדחה' }
}

$nodeArgs = @($script, $Command)
switch ($Command) {
  'backup' {
    if ($Source -eq '') { throw 'backup דורש -Source <project>' }
    $nodeArgs += @('--source', $Source)
    if ($Out -ne '') { $nodeArgs += @('--out', $Out) }
    if ($Execute) { $nodeArgs += '--execute' }
    elseif ($DryRun) { $nodeArgs += '--dry-run' }
    # ברירת מחדל ב-Node: dry-run. -Execute בלבד מפעיל גיבוי אמיתי + חותם.
  }
  'verify' {
    if ($Set -eq '') { throw 'verify דורש -Set <dir>' }
    $nodeArgs += @('--set', $Set)
  }
  'plan' {
    if ($Set -eq '') { throw 'plan דורש -Set <dir>' }
    if ($Target -eq '') { throw 'plan דורש -Target <project>' }
    $nodeArgs += @('--set', $Set, '--target', $Target)
  }
  'restore' {
    if ($Set -eq '') { throw 'restore דורש -Set <dir>' }
    if ($Target -eq '') { throw 'restore דורש -Target <project>' }
    $nodeArgs += @('--set', $Set, '--target', $Target)
    if ($Execute) { $nodeArgs += @('--execute', '--confirm-target', $ConfirmTarget) }
    else { $nodeArgs += '--dry-run' }
  }
  'report' {
    if ($Set -eq '') { throw 'report דורש -Set <dir>' }
    $nodeArgs += @('--set', $Set)
  }
}

$mode = 'dry-run'
if ($Execute) { $mode = 'EXECUTE' }
Write-Host ('ops-disaster-restore · PowerShell ' + $PSVersionTable.PSVersion.Major + ' · ' + $Command + ' · ' + $mode)
& $node.Source @nodeArgs
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 1 }
exit $code
