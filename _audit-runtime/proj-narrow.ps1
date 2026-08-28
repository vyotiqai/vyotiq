$files = Get-ChildItem _audit-runtime -Recurse -File -Include 'events*.jsonl'
"=== tool_result ok:false ==="
foreach ($f in $files) {
  $name = Split-Path $f.FullName -Parent | Split-Path -Leaf
  $n = 0
  foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
    $n++
    if ($line -match '"type":"tool_result"' -and $line -match '"ok":false') {
      $s = $line; if ($s.Length -gt 500) { $s = $s.Substring(0,500) + '...' }
      "[${name}:${n}] $s"
    }
  }
}
"=== status / compaction / goal_update / mode_changed / token_cost_hint / no-type lines ==="
foreach ($f in $files) {
  $name = Split-Path $f.FullName -Parent | Split-Path -Leaf
  $n = 0
  foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
    $n++
    $i = $line.IndexOf('"type":"')
    $t = if ($i -ge 0) { $line.Substring($i + 8, ($line.IndexOf('"', $i + 8) - $i - 8)) } else { '(no-type)' }
    if ($t -in @('status','compaction','compaction_started','compaction_verifying','goal_update','mode_changed','token_cost_hint','writes_checkpoint','(no-type)')) {
      $s = $line; if ($s.Length -gt 700) { $s = $s.Substring(0,700) + '...' }
      "[${name}:${n}] $s"
    }
  }
}
