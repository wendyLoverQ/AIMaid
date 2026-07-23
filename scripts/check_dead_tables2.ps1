# Get all table names from DB
$tables = @("ActionTagDefinitions","AgentCapabilities","AgentToolCalls","AiConversations","AppRuntimeStates","AppSettings","ChatCommandLaunchers","ChatMessages","CoreBackgroundTasks","CryptoMarketEvents","CryptoMarketProviderConfigurations","CryptoMarketWatchlistItems","DesktopContextSnapshots","DisturbanceSettings","LlmBusinessModelConfigs","LlmCallLogs","LlmChatConversations","LlmChatMessages","LlmProviderSelections","LlmSourcePrompts","MaidStates","NotebookAttachments","NotebookNotes","ProactiveBroadcastSourceSettings","ProactiveBroadcastTriggerLogs","ProactiveTriggerRules","ProactiveTriggerStates","ReminderLogs","Reminders","RemoteDownloadTasks","RemotePlayHistories","RemoteSiteConfigs","RemoteVideoItems","RemoteVideoSettings","TimerRecords","UserProfiles","VaultItemHistories","VaultItems","VideoAlbums","VideoItems","VideoPlaybackHistories","VideoSubtitleBindings","VideoTagDefinitions","VoiceAssets","VoiceCacheDedupeLogs","VoiceConversations","VoiceRoleAudioCaches","VoiceRoleBindings","VoiceRoleCards","VoiceRoleVoices","VoiceRoles","VoiceTriggerLogs")

$codeRoot = "C:\Users\49213\Desktop\A\codex\AIMaid"
$allFiles = Get-ChildItem -Path $codeRoot -Recurse -Include *.cs,*.ts,*.tsx -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "\\release\\" -and $_.FullName -notmatch "\\node_modules\\" -and $_.FullName -notmatch "\\obj\\" -and $_.FullName -notmatch "\\bin\\" }

$allContent = ""
foreach ($f in $allFiles) {
    $allContent += [System.IO.File]::ReadAllText($f.FullName)
}

$dead = @()
foreach ($t in $tables) {
    if ($allContent -notmatch [regex]::Escape($t)) {
        $dead += $t
    }
}

Write-Output "Dead tables (not referenced in any .cs/.ts/.tsx):"
foreach ($d in $dead) {
    Write-Output "  - $d"
}
Write-Output ""
Write-Output "Total: $($dead.Count) dead tables"