$files = Get-ChildItem _audit-runtime -Recurse -Filter 'events*.jsonl'
$types = @{}
$total = 0
foreach ($f in $files) {
  foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
    $total++
    $i = $line.IndexOf('"type":"')
    if ($i -lt 0) { $t = '(no-type)' } else {
      $j = $line.IndexOf('"', $i + 8)
      if ($j -lt 0) { $t = '(malformed)' } else { $t = $line.Substring($i + 8, $j - $i - 8) }
    }
    if ($types.ContainsKey($t)) { $types[$t]++ } else { $types[$t] = 1 }
  }
}
"total lines: $total  files: $($files.Count)"
$types.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { "{0,8}  {1}" -f $_.Value, $_.Name }
