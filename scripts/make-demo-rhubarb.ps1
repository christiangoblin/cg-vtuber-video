param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$Text
)

$sentence = ($Text -join " ").Trim()

if (-not $sentence) {
  Write-Error "Usage: .\scripts\make-demo-rhubarb.ps1 Your sentence here"
  exit 1
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

New-Item -ItemType Directory -Force public\audio | Out-Null
New-Item -ItemType Directory -Force public\cues | Out-Null

$rhubarbExe = Join-Path $projectRoot "tools\rhubarb\Rhubarb-Lip-Sync-1.14.0-Windows\rhubarb.exe"

if (-not (Test-Path $rhubarbExe)) {
  Write-Error "Could not find Rhubarb at: $rhubarbExe"
  exit 1
}

Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0

$audioOut = Join-Path $projectRoot "public\audio\test-audio.wav"

if (Test-Path $audioOut) {
  Remove-Item $audioOut -Force
}

$synth.SetOutputToWaveFile($audioOut)
$synth.Speak($sentence)
$synth.Dispose()

$rhubarbOut = Join-Path $projectRoot "public\cues\rhubarb.json"

& $rhubarbExe -f json -o $rhubarbOut $audioOut

node scripts\convert-rhubarb-to-vrm.mjs public\cues\rhubarb.json public\cues\test-cues.json

(Get-Content src\App.jsx -Raw) -replace '/audio/test-audio.mp3','/audio/test-audio.wav' | Set-Content src\App.jsx -Encoding UTF8

Write-Host "Generated audio: public\audio\test-audio.wav"
Write-Host "Generated Rhubarb cues: public\cues\rhubarb.json"
Write-Host "Generated VRM cues: public\cues\test-cues.json"
Write-Host "Sentence: $sentence"
