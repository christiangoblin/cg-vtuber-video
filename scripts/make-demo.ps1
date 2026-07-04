param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$Text
)

$sentence = ($Text -join " ").Trim()

if (-not $sentence) {
  Write-Error "Usage: .\scripts\make-demo.ps1 Your sentence here"
  exit 1
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

New-Item -ItemType Directory -Force public\audio | Out-Null
New-Item -ItemType Directory -Force public\cues | Out-Null

Add-Type -AssemblyName System.Speech

$script:wordEvents = New-Object System.Collections.ArrayList

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0

$synth.add_SpeakProgress({
  param($sender, $eventArgs)

  [void]$script:wordEvents.Add([pscustomobject]@{
    text = $eventArgs.Text
    start = [Math]::Round($eventArgs.AudioPosition.TotalSeconds, 3)
  })
})

$out = Join-Path $projectRoot "public\audio\test-audio.wav"

if (Test-Path $out) {
  Remove-Item $out -Force
}

$synth.SetOutputToWaveFile($out)
$synth.Speak($sentence)
$synth.Dispose()

function Get-WavDurationSeconds($filePath) {
  $bytes = [System.IO.File]::ReadAllBytes($filePath)

  $riff = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
  $wave = [System.Text.Encoding]::ASCII.GetString($bytes, 8, 4)

  if ($riff -ne "RIFF" -or $wave -ne "WAVE") {
    throw "Not a valid WAV file."
  }

  $position = 12
  $byteRate = 0
  $dataSize = 0

  while ($position + 8 -le $bytes.Length) {
    $chunkId = [System.Text.Encoding]::ASCII.GetString($bytes, $position, 4)
    $chunkSize = [System.BitConverter]::ToInt32($bytes, $position + 4)
    $chunkDataStart = $position + 8

    if ($chunkId -eq "fmt ") {
      $byteRate = [System.BitConverter]::ToInt32($bytes, $chunkDataStart + 8)
    }

    if ($chunkId -eq "data") {
      $dataSize = $chunkSize
      break
    }

    $position += 8 + $chunkSize

    if ($chunkSize % 2 -eq 1) {
      $position += 1
    }
  }

  if ($byteRate -le 0 -or $dataSize -le 0) {
    throw "Could not read WAV duration."
  }

  return $dataSize / $byteRate
}

$duration = Get-WavDurationSeconds $out
$durationRounded = [Math]::Round($duration, 3)

$timings = [pscustomobject]@{
  duration = $durationRounded
  words = @($script:wordEvents)
}

$timingsPath = Join-Path $projectRoot "public\cues\word-timings.json"
$timings | ConvertTo-Json -Depth 8 | Set-Content $timingsPath -Encoding UTF8

node scripts\generate-mouth-cues-from-wav.mjs public/audio/test-audio.wav

(Get-Content src\App.jsx -Raw) -replace '/audio/test-audio.mp3','/audio/test-audio.wav' | Set-Content src\App.jsx -Encoding UTF8

Write-Host "Generated audio: public\audio\test-audio.wav"
Write-Host "Generated audio-based mouth cues from WAV"
Write-Host "Generated mouth cues: public\cues\test-cues.json"
Write-Host "Audio duration: $durationRounded seconds"
Write-Host "Words timed: $($script:wordEvents.Count)"
Write-Host "Sentence: $sentence"

