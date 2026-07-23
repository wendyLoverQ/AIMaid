$tables = @("ActionTagDefinitions","AgentCapabilities","AgentToolCalls","AiConversations","AppRuntimeStates","AppSettings","ChatCommandLaunchers","ChatMessages","CoreBackgroundTasks","CryptoMarketEvents","CryptoMarketProviderConfigurations","CryptoMarketWatchlistItems","DesktopContextSnapshots","DisturbanceSettings","LlmBusinessModelConfigs","LlmCallLogs","LlmChatConversations","LlmChatMessages","LlmProviderSelections","LlmSourcePrompts","MaidStates","NotebookAttachments","NotebookNotes","ProactiveBroadcastSourceSettings","ProactiveBroadcastTriggerLogs","ProactiveTriggerRules","ProactiveTriggerStates","ReminderLogs","Reminders","RemoteDownloadTasks","RemotePlayHistories","RemoteSiteConfigs","RemoteVideoItems","RemoteVideoSettings","TimerRecords","UserProfiles","VaultItemHistories","VaultItems","VideoAlbums","VideoItems","VideoPlaybackHistories","VideoSubtitleBindings","VideoTagDefinitions","VoiceAssets","VoiceCacheDedupeLogs","VoiceConversations","VoiceRoleAudioCaches","VoiceRoleBindings","VoiceRoleCards","VoiceRoleVoices","VoiceRoles","VoiceTriggerLogs")

$codeRoot = "C:\Users\49213\Desktop\A\codex\AIMaid"

# Collect all content from src/ only (business code, excluding tools/ and tests/)
$srcFiles = Get-ChildItem -Path "$codeRoot\src" -Recurse -Include *.cs,*.ts,*.tsx -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "\\release\\" -and $_.FullName -notmatch "\\node_modules\\" -and $_.FullName -notmatch "\\obj\\" -and $_.FullName -notmatch "\\bin\\" }

$srcContent = ""
foreach ($f in $srcFiles) {
    $srcContent += [System.IO.File]::ReadAllText($f.FullName)
}

# Also collect from apps/ (Electron desktop app code)
$appFiles = Get-ChildItem -Path "$codeRoot\apps" -Recurse -Include *.ts,*.tsx -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "\\release\\" -and $_.FullName -notmatch "\\node_modules\\" -and $_.FullName -notmatch "\\dist\\" }

$appContent = ""
foreach ($f in $appFiles) {
    $appContent += [System.IO.File]::ReadAllText($f.FullName)
}

$allBizContent = $srcContent + $appContent

Write-Output "=== DEAD TABLES (not in src/ or apps/) ==="
$dead = @()
foreach ($t in $tables) {
    if ($allBizContent -notmatch [regex]::Escape($t)) {
        $dead += $t
    }
}

if ($dead.Count -eq 0) {
    Write-Output "  None - all tables referenced in business code"
} else {
    foreach ($d in $dead) {
        Write-Output "  - $d"
    }
}

Write-Output ""
Write-Output "=== TOOLS-ONLY TABLES (only in tools/, not in src/ or apps/) ==="
$toolsOnly = @()
# Collect all tools content once
$toolsFiles = Get-ChildItem -Path "$codeRoot\tools" -Recurse -Include *.cs -ErrorAction SilentlyContinue
$toolsContent = ""
foreach ($f in $toolsFiles) {
    $toolsContent += [System.IO.File]::ReadAllText($f.FullName)
}

foreach ($t in $tables) {
    if ($allBizContent -match [regex]::Escape($t)) {
        continue  # Referenced in biz code, skip
    }
    # Not in biz code, check if in tools
    if ($toolsContent -match [regex]::Escape($t)) {
        $toolsOnly += $t
    }
}

if ($toolsOnly.Count -eq 0) {
    Write-Output "  None"
} else {
    foreach ($t in $toolsOnly) {
        Write-Output "  - $t"
    }
}