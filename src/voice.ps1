# Offline speech recognition for Skadi's voice control, using the Windows
# speech engine (System.Speech, part of every Windows install). It listens on
# the default microphone and prints one JSON line per event:
#   {"type":"ready","culture":"en-US"}
#   {"type":"partial","text":"..."}
#   {"type":"heard","text":"...","confidence":0.83}
#   {"type":"error","message":"..."}
# It runs until the Skadi process that started it (-ParentPid) exits or kills it.
param([string]$Culture = '', [string]$Wake = '', [int]$ParentPid = 0, [string]$Wav = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Say($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

# How to say wake words dictation cannot spell, in the SAPI phone set. Without
# this, Windows hears "Skadi" as "study", "scud" or "the deal".
$Pronounce = @{
  skadi = @('s k aa d iy', 's k ae d iy', 's k aa t iy')
}

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
  # Free dictation only without a wake word: beside the wake grammar it wins
  # the vote and turns "Skadi, open notepad" into "To daddy open notepad".
  # (A bare "Skadi" cannot arm the next sentence either: one word alone is
  # scored near zero and rejected, so the command comes in the same breath.)
  if (-not $Wake) { $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)) }
  # "Wake word, then optionally anything": a grammar of its own, with the
  # word's pronunciation spelled out, so the engine listens for that sound.
  if ($Wake) {
    $S = 'System.Speech.Recognition.SrgsGrammar'
    $doc = New-Object "$S.SrgsDocument"
    $doc.Culture = $info.Culture
    $doc.PhoneticAlphabet = [System.Speech.Recognition.SrgsGrammar.SrgsPhoneticAlphabet]::Sapi
    $rule = New-Object "$S.SrgsRule" 'wake'
    # The wake word in each of its pronunciations.
    function New-Spoken {
      $spoken = New-Object "$S.SrgsOneOf"
      $prons = $Pronounce[$Wake.ToLower()]
      if ($prons) {
        foreach ($p in $prons) {
          $token = New-Object "$S.SrgsToken" $Wake
          $token.Pronunciation = $p
          $spoken.Add((New-Object "$S.SrgsItem" $token))
        }
      } else {
        $spoken.Add((New-Object "$S.SrgsItem" $Wake))
      }
      return ,$spoken
    }
    $rule.Add((New-Object "$S.SrgsItem" (New-Spoken)))
    $tail = New-Object "$S.SrgsItem" 0, 1
    $tail.Add([System.Speech.Recognition.SrgsGrammar.SrgsRuleRef]::Dictation)
    $rule.Add($tail)
    $doc.Rules.Add($rule)
    $doc.Root = $rule
    $grammar = New-Object System.Speech.Recognition.Grammar $doc
    $grammar.Name = 'wake'
    $engine.LoadGrammar($grammar)

  }
  if ($Wav) { $engine.SetInputToWaveFile($Wav) } else { $engine.SetInputToDefaultAudioDevice() }
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(700)

  Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier heard | Out-Null
  Register-ObjectEvent -InputObject $engine -EventName SpeechHypothesized -SourceIdentifier partial | Out-Null
  Register-ObjectEvent -InputObject $engine -EventName RecognizeCompleted -SourceIdentifier finished | Out-Null
  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Say @{ type = 'ready'; culture = $info.Culture.Name }

  # Nothing here may block: a stdin read in Windows PowerShell 5.1 does, and
  # stalled this loop after the first event. Watch the parent instead.
  while ($true) {
    $evt = Wait-Event -Timeout 1
    if (-not $evt) {
      if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
      continue
    }
    $result = $evt.SourceEventArgs.Result
    $id = $evt.SourceIdentifier
    Remove-Event -EventIdentifier $evt.EventIdentifier
    if ($id -eq 'finished') { break }
    if ($id -eq 'heard' -and $result) {
      $isWake = $result.Grammar.Name -eq 'wake'
      # The wake grammar bends any speech toward "Skadi ..."; a weak match is noise.
      if ($isWake -and $result.Confidence -lt 0.45) { continue }
      Say @{ type = 'heard'; text = $result.Text; confidence = [Math]::Round($result.Confidence, 2); wake = $isWake }
    } elseif ($id -eq 'partial' -and $result) {
      Say @{ type = 'partial'; text = $result.Text }
    }
  }
  $engine.RecognizeAsyncCancel()
  $engine.Dispose()
} catch {
  Say @{ type = 'error'; message = $_.Exception.Message }
  exit 1
}
