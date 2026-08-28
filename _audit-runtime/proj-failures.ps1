$pat = 'fail|error|retry|exhaust|timeout|circuit|abort|degrad|notice|append|rotat|archiv|overflow|compact|fallback|sanitiz|drop|warn|stall|idle'
$files = Get-ChildItem _audit-runtime -Recurse -File -Include 'events*.jsonl'
$hits = 0
foreach ($f in $files) {
  $name = Split-Path $f.FullName -Parent | Split-Path -Leaf
  $n = 0
  foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
    $n++
    if ($line -notmatch $pat) { continue }
    $hits++
    $at = ''
    $m = [regex]::Match($line, '"at":"([^"]+)"')
    if ($m.Success) { $at = $m.Groups[1].Value }
    $m2 = [regex]::Match($line, '"type":"([^"]+)"')
    $t = if ($m2.Success) { $m2.Groups[1].Value } else { '(?)' }
    $snippet = $line
    if ($snippet.Length -gt 420) { $snippet = $snippet.Substring(0, 420) + '...' }
    "[{0}] {1}:{2} {3}" -f $at, $name, $n, $snippet
  }
}
"--- failure-pattern hits: $hits"
