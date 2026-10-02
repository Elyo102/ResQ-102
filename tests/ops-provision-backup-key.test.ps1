$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path $PSScriptRoot) 'ops-provision-backup-key.ps1'
$shell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$warning = '# DISCLOSED CHAT VALUE: synthetic local verification only; NOT a production backup key.'
$marker = '# RESQ_BACKUP_KEY_RANDOM_V1'
$passed = 0
$fixtureRoot = Join-Path (Join-Path (Split-Path $PSScriptRoot) 'outputs') ('provision-key-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
function Check([bool]$condition) {
  if (!$condition) { throw 'synthetic assertion failed' }
  $script:passed++
}
function Fixture([string]$name, [string]$contents) {
  $folder = Join-Path $fixtureRoot $name
  if (Test-Path -LiteralPath $folder) { throw 'fixture already exists' }
  New-Item -ItemType Directory -Path $folder | Out-Null
  Copy-Item -LiteralPath $source -Destination (Join-Path $folder 'ops-provision-backup-key.ps1')
  [IO.File]::WriteAllText((Join-Path $folder '.env.local'), $contents, (New-Object Text.UTF8Encoding($false)))
  return $folder
}
function InvokeFixture([string]$folder, [switch]$WithoutApproval, [byte[]]$ExpectedOverride) {
  $expectedBytes = if ($null -ne $ExpectedOverride) { $ExpectedOverride } else {
    [IO.File]::ReadAllBytes((Join-Path $folder '.env.local'))
  }
  $global:LASTEXITCODE = 0
  if ($WithoutApproval) {
    $output = @(& (Join-Path $folder 'ops-provision-backup-key.ps1') 2>&1)
  } else {
    $output = @(& (Join-Path $folder 'ops-provision-backup-key.ps1') -ReplaceCurrentSynthetic -ExpectedCurrentBytes $expectedBytes 2>&1)
  }
  $status = $LASTEXITCODE
  # Never print captured output on failure; it could contain fixture key bytes.
  Check ($output.Count -eq 1)
  $result = $output[0] | ConvertFrom-Json
  $script:lastSafeStage = if ($result.stage -in @('preflight','protect-existing','validate-state','protect-temporary','atomic-replacement','readback','lock-cleanup')) { $result.stage } else { 'no-failure-stage' }
  Check (@($result.PSObject.Properties.Name | Where-Object {
    $_ -notin @('available','persistedReadbackVerified','privateAclVerified','reused','provisioningSucceeded','stage')
  }).Count -eq 0)
  return @{status=$status; result=$result}
}
try {
  $initial = $warning + "`r`nRESQ_BACKUP_SEAL_PASSPHRASE=synthetic-fixture-not-a-key`r`nUNRELATED_FIXTURE=preserve-me`r`n# preserve comment`r`n"
  $generated = Fixture 'generate' $initial
  $first = InvokeFixture $generated
  Check ($first.status -eq 0 -and $first.result.available -eq $true -and $first.result.reused -eq $false)
  Check ($first.result.persistedReadbackVerified -eq $true -and $first.result.privateAclVerified -eq $true)
  $file = Join-Path $generated '.env.local'
  $before = [IO.File]::ReadAllText($file)
  Check ([regex]::Matches($before, '(?m)^RESQ_BACKUP_SEAL_PASSPHRASE=[a-f0-9]{64}\r?$').Count -eq 1)
  Check ($before.Contains('UNRELATED_FIXTURE=preserve-me') -and $before.Contains('# preserve comment'))
  Check ($before.Contains($marker) -and !$before.Contains($warning))
  $second = InvokeFixture $generated -WithoutApproval
  Check ($second.status -eq 0 -and $second.result.reused -eq $true)
  Check ([IO.File]::ReadAllText($file) -ceq $before)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath $file
  $rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  Check ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid)
  $normalized = [regex]::Replace($before, '(?m)^RESQ_BACKUP_SEAL_PASSPHRASE=[a-f0-9]{64}\r?$', 'RESQ_BACKUP_SEAL_PASSPHRASE=synthetic-fixture-not-a-key' + "`r")
  Check ($normalized -ceq $initial.Replace($warning,$marker))
  $lfInitial = $initial.Replace("`r`n","`n")
  $lfFolder = Fixture 'lf-generation' $lfInitial
  $lfOut = InvokeFixture $lfFolder
  Check ($lfOut.status -eq 0)
  $lfReadback = [IO.File]::ReadAllText((Join-Path $lfFolder '.env.local'))
  $lfNormalized = [regex]::Replace($lfReadback, '(?m)^RESQ_BACKUP_SEAL_PASSPHRASE=[a-f0-9]{64}$', 'RESQ_BACKUP_SEAL_PASSPHRASE=synthetic-fixture-not-a-key')
  Check ($lfNormalized -ceq $lfInitial.Replace($warning,$marker))
  $noApproval = Fixture 'without-approval' $initial
  $noApprovalOut = InvokeFixture $noApproval -WithoutApproval
  Check ($noApprovalOut.status -eq 1 -and $noApprovalOut.result.provisioningSucceeded -eq $false)
  Check ([IO.File]::ReadAllText((Join-Path $noApproval '.env.local')) -ceq $initial)
  $changed = Fixture 'changed-approval' $initial
  $changedOut = InvokeFixture $changed -ExpectedOverride ([Text.Encoding]::UTF8.GetBytes('different synthetic bytes'))
  Check ($changedOut.status -eq 1 -and $changedOut.result.provisioningSucceeded -eq $false)
  Check ([IO.File]::ReadAllText((Join-Path $changed '.env.local')) -ceq $initial)
  foreach ($case in @(
    @{name='duplicate'; content=$initial + "RESQ_BACKUP_SEAL_PASSPHRASE=second-synthetic`r`n"},
    @{name='unknown'; content="RESQ_BACKUP_SEAL_PASSPHRASE=unknown-synthetic-fixture`r`nUNRELATED_FIXTURE=preserve-me`r`n"},
    @{name='duplicate-marker'; content=$marker + "`r`n" + $marker + "`r`nRESQ_BACKUP_SEAL_PASSPHRASE=" + ('a' * 64) + "`r`n"}
  )) {
    $folder = Fixture $case.name $case.content
    $out = InvokeFixture $folder
    Check ($out.status -eq 1 -and $out.result.provisioningSucceeded -eq $false)
    Check ([IO.File]::ReadAllText((Join-Path $folder '.env.local')) -ceq $case.content)
    Check (!(Test-Path -LiteralPath (Join-Path $folder '.env.local.provision.lock')))
  }
  $locked = Fixture 'locked' $initial
  $lockPath = Join-Path $locked '.env.local.provision.lock'
  $held = [IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    $out = InvokeFixture $locked
    Check ($out.status -eq 1 -and $out.result.provisioningSucceeded -eq $false)
    Check ([IO.File]::ReadAllText((Join-Path $locked '.env.local')) -ceq $initial)
    Check (Test-Path -LiteralPath $lockPath)
  } finally { $held.Dispose() }
  @{syntheticOnly=$true; passed=$passed; failed=0; actualEnvironmentRead=$false} | ConvertTo-Json -Compress
} catch {
  @{syntheticOnly=$true; passed=$passed; failed=1; stage=$script:lastSafeStage; actualEnvironmentRead=$false} | ConvertTo-Json -Compress
  exit 1
} finally {
  [Environment]::SetEnvironmentVariable('RESQ_BACKUP_SEAL_PASSPHRASE',$null,'Process')
  $before=$null; $initial=$null; $lfReadback=$null
}
