param([ValidateRange(0,2147483647)][int]$TargetProcessId = 0,
  [ValidatePattern('^8080(?:,[0-9]{5}){0,3}$')][string]$CapturedPorts = '8080')
$ErrorActionPreference = 'Stop'
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
$ownedProcess = $null
$ownedListeners = @()
$descendants = @()
if ($TargetProcessId -gt 0) {
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId" -ErrorAction Stop
  if ($candidate) {
    $ownedProcess = @{ pid = [int]$candidate.ProcessId; parentPID = [int]$candidate.ParentProcessId; path = [string]$candidate.ExecutablePath; createdAt = $candidate.CreationDate.ToUniversalTime().ToString('o') }
  }
  $ownedListeners = @($listeners | Where-Object OwningProcess -eq $TargetProcessId | ForEach-Object {
    @{ pid = [int]$_.OwningProcess; host = [string]$_.LocalAddress; port = [int]$_.LocalPort }
  })
  $descendants = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetProcessId" -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId })
}
$portNumbers = @($CapturedPorts.Split(',') | ForEach-Object { [int]$_ })
$portOwners = @($listeners | Where-Object { $_.LocalPort -in $portNumbers } | ForEach-Object {
  @{ pid = [int]$_.OwningProcess; host = [string]$_.LocalAddress; port = [int]$_.LocalPort }
})
@{ process = $ownedProcess; listeners = $ownedListeners; portOwners = $portOwners; descendants = $descendants } | ConvertTo-Json -Depth 5 -Compress
