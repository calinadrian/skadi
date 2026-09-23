# Offline speech recognition for Skadi's voice control, using the Windows
# speech engine (System.Speech, part of every Windows install). It listens on
# the default microphone and prints one JSON line per event:
#   {"type":"ready","culture":"en-US"}
#   {"type":"partial","text":"..."}
#   {"type":"heard","text":"...","confidence":0.83}
#   {"type":"error","message":"..."}
# It runs until stdin closes.
param([string]$Culture = '', [string]$Wake = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Say($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

try {
  Add-Type -AssemblyName System.Speech
  $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if (-not $installed -or $installed.Count -eq 0) {
    throw 'No Windows speech recognizer is installed. Add one under Settings > Time & language > Speech.'
  }
  $info = $null
  if ($Culture) { $info = $installed | Where-Object { $_.Culture.Name -eq $Culture } | Select-Object -First 1 }
  if (-not $info) { $info = $installed | Where-Object { $_.Culture.Name -eq [System.Globalization.CultureInfo]::CurrentUICulture.Name } | Select-Object -First 1 }
  if (-not $info) { $info = $installed | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }
  if (-not $info) { $info = $installed[0] }

  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $info
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  # Free dictation seldom spells an unusual name like "Skadi" right. A grammar
  # of "wake word, then anything" lets the engine hear it as a word.
  if ($Wake) {
    foreach ($tail in @($true, $false)) {
      $gb = New-Object System.Speech.Recognition.GrammarBuilder
      $gb.Culture = $info.Culture
      $gb.Append($Wake)
      if ($tail) { $gb.AppendDictation() }
      $engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar $gb))
    }
  }
  $engine.SetInputToDefaultAudioDevice()
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(700)

  Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier heard | Out-Null
  Register-ObjectEvent -InputObject $engine -EventName SpeechHypothesized -SourceIdentifier partial | Out-Null
  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Say @{ type = 'ready'; culture = $info.Culture.Name }

  # Poll stdin between events so a closed pipe ends the loop.
  $stdin = [Console]::In
  $readTask = $stdin.ReadLineAsync()
  while ($true) {
    if ($readTask.IsCompleted) {
      if ($null -eq $readTask.Result) { break }
      $readTask = $stdin.ReadLineAsync()
    }
    $evt = Wait-Event -Timeout 1
    if (-not $evt) { continue }
    $result = $evt.SourceEventArgs.Result
    if ($evt.SourceIdentifier -eq 'heard' -and $result) {
      Say @{ type = 'heard'; text = $result.Text; confidence = [Math]::Round($result.Confidence, 2) }
    } elseif ($evt.SourceIdentifier -eq 'partial' -and $result) {
      Say @{ type = 'partial'; text = $result.Text }
    }
    Remove-Event -EventIdentifier $evt.EventIdentifier
  }
  $engine.RecognizeAsyncCancel()
  $engine.Dispose()
} catch {
  Say @{ type = 'error'; message = $_.Exception.Message }
  exit 1
}
