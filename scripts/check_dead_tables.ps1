$dbPath = "C:\Users\49213\Desktop\A\codex\AIMaid\data\aimaid-core.db"
$codeRoot = "C:\Users\49213\Desktop\A\codex\AIMaid"

$tables = sqlite3 $dbPath "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'DbColumn%' ORDER BY name;"

$deadTables = @()
$totalTables = 0

foreach ($table in $tables) {
    $totalTables++
    # Search in C# and TypeScript files
    $matches = Get-ChildItem -Path $codeRoot -Recurse -Include *.cs,*.ts,*.tsx -ErrorAction SilentlyContinue | 
        Select-String -Pattern $table -SimpleMatch 2>$null |
        Where-Object { $_.Path -notmatch "\\release\\" -and $_.Path -notmatch "\\node_modules\\" -and $_.Path -notmatch "\\obj\\" -and $_.Path -notmatch "\\bin\\" -and $_.Path -notmatch "\\migrations\\" -and $_.Path -notmatch "\.db$" }
    
    if ($matches.Count -eq 0) {
        $deadTables += $table
        Write-Output "[DEAD] $table"
    }
}

Write-Output ""
Write-Output "======================"
Write-Output "Total tables: $totalTables"
Write-Output "Dead tables (no code reference): $($deadTables.Count)"
Write-Output "======================"
if ($deadTables.Count -gt 0) {
    foreach ($t in $deadTables) {
        Write-Output "  - $t"
    }
}