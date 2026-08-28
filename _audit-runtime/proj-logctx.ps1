$lines = [System.IO.File]::ReadAllLines("$PWD\_audit-runtime\vyotiq.log")
# Log entries start with a timestamp bracket at col 0; continuation lines are indented.
$starts = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]') { $starts += $i }
}
"entries: $($starts.Count)"
$interesting = 'Circuit opened|Provider .* failure|Compaction|IPC handler failed|Tool execution failed|Archived rotated|Rotated messages|Rotated events|append|Failed to|no summary|returned failure'
$out = New-Object System.Collections.Generic.List[string]
for ($s = 0; $s -lt $starts.Count; $s++) {
  $from = $starts[$s]
  $to = if ($s -lt $starts.Count - 1) { $starts[$s + 1] - 1 } else { $lines.Count - 1 }
  $entry = ($lines[$from..$to] -join "`n")
  if ($entry -match $interesting) {
    if ($entry.Length -gt 900) { $entry = $entry.Substring(0, 900) + ' …' }
    $out.Add($entry)
  }
}
"interesting: $($out.Count)"
$out | ForEach-Object { "===== ENTRY =====`n$_" }
