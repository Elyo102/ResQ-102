param([Parameter(Mandatory=$true)][string]$RootPath, [Parameter(Mandatory=$true)][string]$InventoryPath, [Parameter(Mandatory=$true)][string]$ZipPath, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$entries = @(Get-Content -LiteralPath $InventoryPath -Raw -Encoding UTF8 | ConvertFrom-Json)
$rootPrefix = [System.IO.Path]::GetFullPath($RootPath).TrimEnd('\') + '\'
if (!$VerifyOnly) {
$archive = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($entry in $entries) {
    $source = [System.IO.Path]::GetFullPath((Join-Path $RootPath $entry.path))
    if (!$source.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes root' }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $entry.path) | Out-Null
  }
} finally { $archive.Dispose() }
}
$archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
  if ($archive.Entries.Count -ne $entries.Count) { throw 'ZIP entry count mismatch' }
  foreach ($expected in $entries) {
    $matches = @($archive.Entries | Where-Object { $_.FullName -ceq $expected.path })
    if ($matches.Count -ne 1 -or $matches[0].Length -ne $expected.bytes) { throw 'ZIP inventory mismatch' }
    $stream = $matches[0].Open()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($digest -cne $expected.sha256) { throw 'ZIP content mismatch' }
  }
} finally { $archive.Dispose() }
