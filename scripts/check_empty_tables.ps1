$dbPath = "C:\Users\49213\Desktop\A\codex\AIMaid\data\aimaid-core.db"

$tables = sqlite3 $dbPath "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'DbColumn%' ORDER BY name;"

$emptyTables = @()
$totalTables = 0

foreach ($table in $tables) {
    $count = sqlite3 $dbPath "SELECT COUNT(*) FROM [$table];"
    $totalTables++
    Write-Output "$table : $count rows"
    if ($count -eq "0") {
        $emptyTables += $table
    }
}

Write-Output ""
Write-Output "======================"
Write-Output "Summary: $totalTables total tables"
Write-Output "Empty tables (dead tables): $($emptyTables.Count)"
Write-Output "======================"
if ($emptyTables.Count -gt 0) {
    Write-Output ""
    foreach ($t in $emptyTables) {
        Write-Output "  - $t"
    }
}