param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [ValidateSet("rhubarb", "loudness")]
  [string]$Mode = "rhubarb"
)

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

if (-not (Test-Path $FilePath)) {
  Write-Error "Transcript file not found: $FilePath"
  exit 1
}

$scriptText = Get-Content $FilePath -Raw
$scriptText = $scriptText.Trim()

if (-not $scriptText) {
  Write-Error "Transcript file is empty: $FilePath"
  exit 1
}

if ($Mode -eq "rhubarb") {
  & .\scripts\make-demo-rhubarb.ps1 $scriptText
} else {
  & .\scripts\make-demo.ps1 $scriptText
}

Write-Host "Transcript source: $FilePath"
Write-Host "Mode: $Mode"
