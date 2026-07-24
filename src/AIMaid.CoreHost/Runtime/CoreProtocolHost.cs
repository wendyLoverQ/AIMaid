using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using AIMaid.Contracts.Settings;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Domains;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts;
using AIMaid.Contracts.Integrations;
using AIMaid.Contracts.Music;
using AIMaid.Contracts.Market;
using AIMaid.Core;
using AIMaid.CoreHost.Protocol;
using AIMaid.Infrastructure;
using AIMaid.Platform.Windows;

namespace AIMaid.CoreHost.Runtime;

public sealed class CoreProtocolHost(
    TextReader input,
    ProtocolWriter writer,
    SettingsApplicationService settings,
    ReminderApplicationService reminders,
    CharacterApplicationService characters,
    CharacterAssetApplicationService characterAssets,
    TemplateCardApplicationService templateCards,
    AgentApplicationService agent,
    PetVoiceMenuApplicationService petVoiceMenu,
    MusicApplicationService music,
    BinanceMarketApplicationService market,
    StatusApplicationService status,
    ProactiveApplicationService proactive,
    ProactiveRuntimeService proactiveRuntime,
    StatusServerApplicationService statusServers,
    CodexQuotaApplicationService codexQuota,
    SubtitleApplicationService subtitles,
    VideoLibraryApplicationService videos,
    ChatApplicationService chat,
    SpeechApplicationService speech,
    SettingsBackedSpeechClient ttsRuntime,
    ChatCommandLauncherApplicationService scripts,
    IChatStore chatStore,
    ISettingsStore settingsStore,
    ExtendedDomainApplicationService domains,
    RemoteVideoApplicationService remoteVideos,
    VaultExportApplicationService vaultExport,
    InProcessEventPublisher businessEvents,
    string coreVersion,
    TextWriter error)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static readonly string[] DefaultSafeSettingKeys = ["ui_language"];
    private readonly ConcurrentDictionary<string, CancellationTokenSource> active = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task> running = new(StringComparer.Ordinal);
    private readonly object businessEventGate = new();
    private readonly Dictionary<string, long> businessEventSequences = new(StringComparer.Ordinal);
    private Task businessEventWriteTail = Task.CompletedTask;
    private readonly ConcurrentDictionary<string, DateTimeOffset> recentlyCompleted = new(StringComparer.Ordinal);
    private static readonly TimeSpan RecentRequestRetention = TimeSpan.FromSeconds(60);
    private readonly DateTimeOffset startedAt = DateTimeOffset.UtcNow;
    private volatile bool ready;

    public async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        Log("info", "core_start", null, null, "started", message: "Core protocol host started",
            data: new { coreVersion, protocolVersion = ProtocolConstants.Version });
        businessEvents.EventPublished += OnBusinessEventPublished;
        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await input.ReadLineAsync(cancellationToken);
            if (line is null) break;
            var parsed = Parse(line);
            var request = parsed.Request;
            if (request is null)
            {
                Log("warn", "protocol_rejected", null, null, parsed.ErrorCode ?? "invalid", message: "Protocol message rejected");
                await writer.EventAsync("system.protocol.error", null, 0,
                    new { code = parsed.ErrorCode, message = "收到无效协议消息。" }, cancellationToken);
                continue;
            }
            PruneRecentlyCompleted();
            if (active.ContainsKey(request.Id) || recentlyCompleted.ContainsKey(request.Id))
            {
                Log("warn", "protocol_rejected", request.Id, request.Type, "duplicate", message: "Duplicate request ID rejected");
                await writer.FailureAsync(request, "PROTOCOL_DUPLICATE_REQUEST", "请求 ID 已经使用。", cancellationToken: cancellationToken);
                continue;
            }
            if (request.ProtocolVersion != ProtocolConstants.Version)
            {
                Log("warn", "protocol_rejected", request.Id, request.Type, "version_mismatch", message: "Protocol version mismatch");
                await writer.FailureAsync(request, "PROTOCOL_VERSION_MISMATCH", "协议版本不兼容。",
                    new Dictionary<string, object?> { ["supported"] = ProtocolConstants.Version }, cancellationToken);
                MarkCompleted(request.Id);
                continue;
            }
            if (!ProtocolRequestRegistry.IsRegistered(request.Type))
            {
                Log("warn", "protocol_rejected", request.Id, request.Type, "unknown_type", message: "Unknown request type rejected");
                await writer.FailureAsync(request, "PROTOCOL_UNKNOWN_TYPE", "未注册的消息类型。", cancellationToken: cancellationToken);
                MarkCompleted(request.Id);
                continue;
            }
            if (request.Type == "system.handshake")
            {
                await HandleHandshakeAsync(request, cancellationToken);
                MarkCompleted(request.Id);
                continue;
            }
            if (!ready)
            {
                await writer.FailureAsync(request, "CORE_NOT_READY", "Core 尚未完成握手。", cancellationToken: cancellationToken);
                MarkCompleted(request.Id);
                continue;
            }
            if (request.Type == "system.shutdown")
            {
                await writer.SuccessAsync(request, new { accepted = true }, cancellationToken);
                MarkCompleted(request.Id);
                break;
            }
            if (request.Type == "system.cancel")
            {
                await HandleCancelAsync(request, cancellationToken);
                MarkCompleted(request.Id);
                continue;
            }

            var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            if (!active.TryAdd(request.Id, linked))
            {
                linked.Dispose();
                await writer.FailureAsync(request, "PROTOCOL_DUPLICATE_REQUEST", "请求正在执行。", cancellationToken: cancellationToken);
                MarkCompleted(request.Id);
                continue;
            }
            var task = ExecuteAsync(request, linked);
            running[request.Id] = task;
            _ = task.ContinueWith(completedTask =>
                {
                    running.TryRemove(request.Id, out _);
                    _ = completedTask.Exception;
                }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }

        foreach (var item in active.Values) item.Cancel();
        await Task.WhenAll(running.Values);
        active.Clear();
        recentlyCompleted.Clear();
        businessEvents.EventPublished -= OnBusinessEventPublished;
        await businessEventWriteTail;
        Log("info", "core_exit", null, null, "stopped", message: "Core protocol host stopped",
            data: new { uptimeMs = (long)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds });
        return 0;
    }

    private void OnBusinessEventPublished(object? sender, IBusinessEvent businessEvent)
    {
        var mapped = businessEvent switch
        {
            ChatDeltaEvent value => (Type: "chat.delta", CorrelationId: value.ConversationId, Payload: (object)value),
            ChatCompletedEvent value => (Type: "chat.completed", CorrelationId: value.Completion.ConversationId, Payload: (object)value),
            AgentUiActionRequestedEvent value => (Type: "agent.ui_action_requested", CorrelationId: value.EventId, Payload: (object)value),
            SettingsChangedEvent value => (Type: "settings.changed", CorrelationId: value.EventId, Payload: (object)value),
            CharacterChangedEvent value => (Type: "character.changed", CorrelationId: value.RoleId, Payload: (object)value),
            AIMaid.Contracts.PetVoice.PetVoiceCacheStatusEvent value => (Type: "pet.voice_cache.status", CorrelationId: value.GenerationId, Payload: (object)value),
            AIMaid.Contracts.PetVoice.VoiceCacheConfigurationChangedEvent value => (Type: "pet.voice_cache.configuration_changed", CorrelationId: value.EventId, Payload: (object)value),
            AgentApprovalRequestedEvent value => (Type: "agent.approval_requested", CorrelationId: value.ApprovalToken, Payload: (object)value),
            AgentToolCallCompletedEvent value => (Type: "agent.tool_call_completed", CorrelationId: value.ToolCall.CallId, Payload: (object)value),
            ReminderDeliveryRequestedEvent value => (
                Type: "reminder.delivery.requested",
                CorrelationId: value.Reminder.ReminderId,
                Payload: (object)value
            ),
            ReminderDeliveryCompletedEvent value => (
                Type: "reminder.delivery.completed",
                CorrelationId: value.ReminderId,
                Payload: (object)value
            ),
            ProactiveExecutionRequestedEvent value => (
                Type: "proactive.execution.requested",
                CorrelationId: value.ExecutionId,
                Payload: (object)value
            ),
            ProactiveExecutionCompletedEvent value => (
                Type: "proactive.execution.completed",
                CorrelationId: value.ExecutionId,
                Payload: (object)value
            ),
            MusicPlaybackRequestedEvent value => (Type: "music.playback.requested", CorrelationId: value.EventId, Payload: (object)value),
            MusicPlaybackStateChangedEvent value => (Type: "music.playback.state_changed", CorrelationId: value.EventId, Payload: (object)value),
            MusicPlaybackStoppedEvent value => (Type: "music.playback.stopped", CorrelationId: value.EventId, Payload: (object)value),
            _ => (Type: string.Empty, CorrelationId: string.Empty, Payload: (object)businessEvent)
        };
        if (mapped.Type.Length == 0) return;
        lock (businessEventGate)
        {
            var sequence = businessEventSequences.TryGetValue(mapped.CorrelationId, out var previous) ? previous + 1 : 0;
            businessEventSequences[mapped.CorrelationId] = sequence;
            businessEventWriteTail = businessEventWriteTail.ContinueWith(
                _ => writer.EventAsync(mapped.Type, mapped.CorrelationId, sequence, mapped.Payload, CancellationToken.None),
                CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default).Unwrap();
        }
    }

    private async Task ExecuteAsync(ProtocolRequest request, CancellationTokenSource source)
    {
        var stopwatch = Stopwatch.StartNew();
        Log("info", "request_start", request.Id, request.Type, "started", message: "Core request started",
            data: new { activeRequests = active.Count });
        try
        {
            switch (request.Type)
            {
                case "system.health":
                    await writer.SuccessAsync(request, new
                    {
                        ready,
                        coreVersion,
                        protocolVersion = ProtocolConstants.Version,
                        processId = Environment.ProcessId,
                        uptimeMs = (long)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds
                    }, source.Token);
                    break;
                case "system.window.fit_virtual_desktop":
                    await writer.SuccessAsync(request,
                        WindowsPetWindowController.FitVirtualDesktop(ReadRequiredString(request.Payload, "windowHandle")),
                        source.Token);
                    break;
                case "system.window.center_on_client_rect":
                    await writer.SuccessAsync(request,
                        WindowsPetWindowController.CenterWindowOnClientRectangle(
                            ReadRequiredString(request.Payload, "petWindowHandle"),
                            ReadRequiredString(request.Payload, "targetWindowHandle"),
                            ReadDouble(request.Payload, "x"),
                            ReadDouble(request.Payload, "y"),
                            ReadDouble(request.Payload, "width", positive: true),
                            ReadDouble(request.Payload, "height", positive: true),
                            ReadDouble(request.Payload, "viewportWidth", positive: true),
                            ReadDouble(request.Payload, "viewportHeight", positive: true)),
                        source.Token);
                    break;
                case "settings.get":
                    await HandleSettingsGetAsync(request, source.Token);
                    break;
                case "settings.save":
                    await HandleSettingsSaveAsync(request, source.Token);
                    break;
                case "chat.history":
                    await HandleChatHistoryAsync(request, source.Token);
                    break;
                case "chat.send":
                    await HandleValueResultAsync(request, await chat.HandleAsync(new SendChatCommand(
                        ReadRequiredString(request.Payload, "content"),
                        TryGetString(request.Payload, "conversationId", out var chatConversationId) ? chatConversationId : null,
                        TryGetString(request.Payload, "characterId", out var characterId) ? characterId : null,
                        TryGetString(request.Payload, "modelName", out var modelName) ? modelName : null,
                        "voice_conversation_center"), source.Token), source.Token);
                    break;
                case "chat.update_metadata":
                    await HandleResultAsync(request, await chat.HandleAsync(new UpdateChatMessageMetadataCommand(
                        ReadLong(request.Payload, "messageId", 1, long.MaxValue),
                        ReadString(request.Payload, "metadataJson")), source.Token), source.Token);
                    break;
                case "tts.speak":
                    await HandleValueResultAsync(request, await speech.HandleAsync(new SpeakTextCommand(
                        ReadRequiredString(request.Payload, "text"),
                        ReadOptionalString(request.Payload, "voiceId"),
                        ReadOptionalString(request.Payload, "style") ?? "normal"), source.Token), source.Token);
                    break;
                case "asr.transcribe":
                    await HandleValueResultAsync(request, await speech.HandleAsync(new TranscribeAudioCommand(
                        ReadRequiredString(request.Payload, "audioPath"),
                        ReadOptionalString(request.Payload, "characterId"),
                        ReadOptionalString(request.Payload, "sessionId"),
                        ReadOptionalString(request.Payload, "language") ?? "zh",
                        ReadOptionalString(request.Payload, "requestId")), source.Token), source.Token);
                    break;
                case "notebook.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListNotebookNotesQuery(), source.Token), source.Token);
                    break;
                case "notebook.save":
                    await HandleNotebookSaveAsync(request, source.Token);
                    break;
                case "notebook.attachment.add":
                    await HandleNotebookAttachmentSaveAsync(request, source.Token);
                    break;
                case "notebook.delete":
                    await HandleResultAsync(request, await domains.HandleAsync(new DeleteNotebookNoteCommand(ReadRequiredString(request.Payload, "noteId")), source.Token), source.Token);
                    break;
                case "video.list":
                    await writer.SuccessAsync(request, await videos.HandleAsync(new ListVideosQuery(ReadOptionalBoolean(request.Payload, "favoritesOnly")), source.Token), source.Token);
                    break;
                case "video.import_file":
                    await HandleValueResultAsync(request, await videos.HandleAsync(new ImportVideoFileCommand(ReadRequiredString(request.Payload, "filePath"), ReadOptionalString(request.Payload, "albumId")), source.Token), source.Token);
                    break;
                case "video.import_folder":
                    await HandleValueResultAsync(request, await videos.HandleAsync(new ImportVideoFolderCommand(ReadRequiredString(request.Payload, "folderPath"), ReadBoolean(request.Payload, "recursive"), ReadOptionalString(request.Payload, "albumId")), source.Token), source.Token);
                    break;
                case "video.refresh_metadata":
                    await HandleValueResultAsync(request, await videos.HandleAsync(new RefreshVideoMetadataCommand(ReadStringArray(request.Payload, "videoIds")), source.Token), source.Token);
                    break;
                case "video.toggle_favorite":
                    await HandleResultAsync(request, await videos.HandleAsync(new ToggleVideoFavoriteCommand(ReadRequiredString(request.Payload, "videoId")), source.Token), source.Token);
                    break;
                case "video.set_display_name":
                    await HandleResultAsync(request, await videos.HandleAsync(new SetVideoDisplayNameCommand(ReadRequiredString(request.Payload, "videoId"), ReadRequiredString(request.Payload, "displayName")), source.Token), source.Token);
                    break;
                case "video.set_remark":
                    await HandleResultAsync(request, await videos.HandleAsync(new SetVideoRemarkCommand(ReadRequiredString(request.Payload, "videoId"), ReadString(request.Payload, "remark")), source.Token), source.Token);
                    break;
                case "video.update_progress":
                    await HandleResultAsync(request, await videos.HandleAsync(new UpdateVideoProgressCommand(ReadRequiredString(request.Payload, "videoId"), ReadInt(request.Payload, "positionSeconds", 0, int.MaxValue, 0), ReadInt(request.Payload, "durationSeconds", 0, int.MaxValue, 0)), source.Token), source.Token);
                    break;
                case "video.album.create":
                    await HandleValueResultAsync(request, await videos.HandleAsync(new CreateVideoAlbumCommand(ReadRequiredString(request.Payload, "name"), ReadString(request.Payload, "description")), source.Token), source.Token);
                    break;
                case "video.album.rename":
                    await HandleResultAsync(request, await videos.HandleAsync(new RenameVideoAlbumCommand(ReadRequiredString(request.Payload, "albumId"), ReadRequiredString(request.Payload, "name")), source.Token), source.Token);
                    break;
                case "video.album.delete":
                    await HandleResultAsync(request, await videos.HandleAsync(new DeleteVideoAlbumCommand(ReadRequiredString(request.Payload, "albumId")), source.Token), source.Token);
                    break;
                case "video.album.move":
                    await HandleResultAsync(request, await videos.HandleAsync(new MoveVideosToAlbumCommand(ReadStringArray(request.Payload, "videoIds"), ReadOptionalString(request.Payload, "albumId")), source.Token), source.Token);
                    break;
                case "video.tag.create":
                    await HandleResultAsync(request, await videos.HandleAsync(new CreateVideoTagCommand(ReadRequiredString(request.Payload, "tag")), source.Token), source.Token);
                    break;
                case "video.tag.rename":
                    await HandleResultAsync(request, await videos.HandleAsync(new RenameVideoTagCommand(ReadRequiredString(request.Payload, "oldTag"), ReadRequiredString(request.Payload, "newTag")), source.Token), source.Token);
                    break;
                case "video.tag.delete":
                    await HandleResultAsync(request, await videos.HandleAsync(new DeleteVideoTagCommand(ReadRequiredString(request.Payload, "tag")), source.Token), source.Token);
                    break;
                case "video.tag.set":
                    await HandleResultAsync(request, await videos.HandleAsync(new SetVideoTagsCommand(
                        ReadStringArray(request.Payload, "videoIds"), ReadString(request.Payload, "tags"),
                        ReadOptionalString(request.Payload, "mode") ?? "replace"), source.Token), source.Token);
                    break;
                case "video.remove_records":
                    await HandleResultAsync(request, await videos.HandleAsync(new RemoveVideoRecordsCommand(ReadStringArray(request.Payload, "videoIds")), source.Token), source.Token);
                    break;
                case "video.delete_local_files":
                    await HandleResultAsync(request, await videos.HandleAsync(new DeleteVideoLocalFilesCommand(ReadStringArray(request.Payload, "videoIds")), source.Token), source.Token);
                    break;
                case "video.play":
                    await HandleValueResultAsync(request, await videos.HandleAsync(new PlayVideosCommand(ReadStringArray(request.Payload, "videoIds"), ReadRequiredString(request.Payload, "startVideoId")), source.Token), source.Token);
                    break;
                case "video.dependencies":
                    await writer.SuccessAsync(request, await videos.HandleAsync(new GetVideoDependenciesQuery(), source.Token), source.Token);
                    break;
                case "subtitle.list":
                    await writer.SuccessAsync(request, await subtitles.HandleAsync(new ListSubtitlesQuery(), source.Token), source.Token);
                    break;
                case "subtitle.import":
                    await HandleValueResultAsync(request, await subtitles.HandleAsync(new ImportSubtitleCommand(ReadRequiredString(request.Payload, "sourcePath")), source.Token), source.Token);
                    break;
                case "subtitle.import_folder":
                    await HandleValueResultAsync(request, await subtitles.HandleAsync(new ImportSubtitleFolderCommand(ReadRequiredString(request.Payload, "folderPath")), source.Token), source.Token);
                    break;
                case "subtitle.delete":
                    await HandleResultAsync(request, await subtitles.HandleAsync(new DeleteSubtitleCommand(ReadRequiredString(request.Payload, "path")), source.Token), source.Token);
                    break;
                case "vault.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListVaultItemsQuery(TryGetString(request.Payload, "itemType", out var itemType) ? itemType : null), source.Token), source.Token);
                    break;
                case "vault.get":
                    await HandleValueResultAsync(request, await domains.HandleAsync(new GetVaultItemQuery(ReadRequiredString(request.Payload, "itemId")), source.Token), source.Token);
                    break;
                case "vault.secret.reveal":
                    await HandleValueResultAsync(request, await domains.HandleAsync(new RevealVaultSecretQuery(ReadRequiredString(request.Payload, "itemId")), source.Token), source.Token);
                    break;
                case "vault.save":
                    await HandleVaultSaveAsync(request, source.Token);
                    break;
                case "vault.delete":
                    await HandleResultAsync(request, await domains.HandleAsync(new DeleteVaultItemCommand(ReadRequiredString(request.Payload, "itemId")), source.Token), source.Token);
                    break;
                case "vault.history.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListVaultHistoriesQuery(ReadRequiredString(request.Payload, "itemId")), source.Token), source.Token);
                    break;
                case "vault.history.restore":
                    await HandleResultAsync(request, await domains.HandleAsync(new RestoreVaultHistoryCommand(ReadRequiredString(request.Payload, "historyId")), source.Token), source.Token);
                    break;
                case "vault.export":
                    await HandleResultAsync(request, await vaultExport.HandleAsync(new ExportVaultCommand(ReadRequiredString(request.Payload, "outputPath")), source.Token), source.Token);
                    break;
                case "voice_conversation.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListVoiceConversationsQuery(
                        TryGetString(request.Payload, "roleId", out var roleId) ? roleId : null,
                        TryGetString(request.Payload, "search", out var search) ? search : null), source.Token), source.Token);
                    break;
                case "voice_conversation.save":
                    await HandleVoiceConversationSaveAsync(request, source.Token);
                    break;
                case "voice_conversation.delete": {
                    var conversationId = ReadRequiredString(request.Payload, "conversationId");
                    await HandleResultAsync(request, await domains.HandleAsync(new DeleteVoiceConversationCommand(conversationId), source.Token), source.Token);
                    break;
                }
                case "script.list":
                    await writer.SuccessAsync(request, await scripts.HandleAsync(new ListChatCommandLaunchersQuery(), source.Token), source.Token);
                    break;
                case "script.save": {
                    if (!request.Payload.TryGetProperty("launcher", out var launcherElement)) throw new ArgumentException("缺少 launcher。");
                    var launcher = launcherElement.Deserialize<ChatCommandLauncherDto>(JsonOptions) ?? throw new ArgumentException("快捷脚本字段不完整。");
                    await HandleValueResultAsync(request, await scripts.HandleAsync(new SaveChatCommandLauncherCommand(launcher), source.Token), source.Token);
                    break;
                }
                case "script.run":
                    await HandleValueResultAsync(request, await scripts.HandleAsync(new RunChatCommandLauncherCommand(ReadRequiredString(request.Payload, "launcherId")), source.Token), source.Token);
                    break;
                case "timer_record.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListTimerRecordsQuery(), source.Token), source.Token);
                    break;
                case "timer_record.save": {
                    if (!request.Payload.TryGetProperty("record", out var recordElement)) throw new ArgumentException("缺少 record。");
                    var record = recordElement.Deserialize<TimerRecordDto>(JsonOptions) ?? throw new ArgumentException("计时记录字段不完整。");
                    await HandleResultAsync(request, await domains.HandleAsync(new SaveTimerRecordCommand(record), source.Token), source.Token);
                    break;
                }
                case "timer_record.delete":
                    await HandleResultAsync(request, await domains.HandleAsync(new DeleteTimerRecordCommand(ReadRequiredString(request.Payload, "recordId")), source.Token), source.Token);
                    break;
                case "remote_site.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListRemoteSitesQuery(ReadOptionalBoolean(request.Payload, "enabledOnly")), source.Token), source.Token);
                    break;
                case "remote_site.get":
                    await HandleValueResultAsync(request, await domains.HandleAsync(new GetRemoteSiteQuery(ReadRequiredString(request.Payload, "siteId")), source.Token), source.Token);
                    break;
                case "remote_site.save": {
                    if (!request.Payload.TryGetProperty("site", out var siteElement)) throw new ArgumentException("缺少 site。");
                    var site = siteElement.Deserialize<RemoteSiteDto>(JsonOptions) ?? throw new ArgumentException("站点配置字段不完整。");
                    var cookie = request.Payload.TryGetProperty("plainCookie", out var cookieElement) && cookieElement.ValueKind == JsonValueKind.String ? cookieElement.GetString() : null;
                    await HandleValueResultAsync(request, await domains.HandleAsync(new SaveRemoteSiteCommand(site, cookie), source.Token), source.Token);
                    break;
                }
                case "remote_site.delete":
                    await HandleResultAsync(request, await domains.HandleAsync(new DeleteRemoteSiteCommand(ReadRequiredString(request.Payload, "siteId")), source.Token), source.Token);
                    break;
                case "remote_video.resolve":
                    await writer.SuccessAsync(request, await remoteVideos.ResolveAsync(ReadRequiredString(request.Payload, "input"), source.Token), source.Token);
                    break;
                case "remote_video.thumbnail":
                    await writer.SuccessAsync(request,
                        TryGetString(request.Payload, "itemId", out var thumbnailItemId)
                            ? await remoteVideos.GetThumbnailAsync(thumbnailItemId, source.Token)
                            : TryGetString(request.Payload, "downloadTaskId", out var thumbnailTaskId)
                                ? await remoteVideos.GetDownloadThumbnailAsync(thumbnailTaskId, source.Token)
                                : await remoteVideos.GetPlayThumbnailAsync(
                                    ReadRequiredString(request.Payload, "playHistoryId"), source.Token),
                        source.Token);
                    break;
                case "remote_video.formats":
                    await writer.SuccessAsync(request, await remoteVideos.GetFormatsAsync(ReadRequiredString(request.Payload, "itemId"), source.Token), source.Token);
                    break;
                case "remote_video.play":
                    await writer.SuccessAsync(request, await remoteVideos.PlayAsync(
                        ReadRequiredString(request.Payload, "itemId"),
                        TryGetString(request.Payload, "formatSelector", out var playSelector) ? playSelector : null,
                        TryGetString(request.Payload, "mode", out var playMode) ? playMode : "direct", source.Token), source.Token);
                    break;
                case "remote_video.download.start": {
                    if (!request.Payload.TryGetProperty("itemIds", out var idsElement) || idsElement.ValueKind != JsonValueKind.Array)
                        throw new ArgumentException("itemIds 必须是字符串数组。");
                    var itemIds = idsElement.EnumerateArray().Select(x => x.GetString() ?? string.Empty)
                        .Where(x => !string.IsNullOrWhiteSpace(x)).ToArray();
                    await writer.SuccessAsync(request, await remoteVideos.StartDownloadsAsync(itemIds,
                        TryGetString(request.Payload, "formatSelector", out var downloadSelector) ? downloadSelector : null, source.Token), source.Token);
                    break;
                }
                case "remote_video.download.cancel":
                    await writer.SuccessAsync(request, new { cancelled = await remoteVideos.CancelDownloadAsync(ReadRequiredString(request.Payload, "taskId"), source.Token) }, source.Token);
                    break;
                case "remote_video.download.list":
                    await writer.SuccessAsync(request, await remoteVideos.ListDownloadsAsync(source.Token), source.Token);
                    break;
                case "remote_video.download.delete":
                    await remoteVideos.DeleteDownloadAsync(ReadRequiredString(request.Payload, "taskId"), source.Token);
                    await writer.SuccessAsync(request, new { succeeded = true }, source.Token);
                    break;
                case "remote_video.download.play":
                    await writer.SuccessAsync(request, await remoteVideos.PlayDownloadAsync(ReadRequiredString(request.Payload, "taskId"), source.Token), source.Token);
                    break;
                case "remote_video.play.list":
                    await writer.SuccessAsync(request, await remoteVideos.ListPlaysAsync(source.Token), source.Token);
                    break;
                case "remote_video.play.replay":
                    await writer.SuccessAsync(request, await remoteVideos.ReplayAsync(ReadRequiredString(request.Payload, "historyId"), source.Token), source.Token);
                    break;
                case "remote_video.settings.get":
                    await writer.SuccessAsync(request, await remoteVideos.GetSettingsAsync(source.Token), source.Token);
                    break;
                case "remote_video.settings.save": {
                    if (!request.Payload.TryGetProperty("settings", out var remoteSettingsElement)) throw new ArgumentException("缺少 settings。");
                    var remoteSettings = remoteSettingsElement.Deserialize<RemoteVideoSettingsDto>(JsonOptions)
                        ?? throw new ArgumentException("远程视频设置字段不完整。");
                    await writer.SuccessAsync(request, await remoteVideos.SaveSettingsAsync(remoteSettings, source.Token), source.Token);
                    break;
                }
                case "remote_video.diagnostics":
                    await writer.SuccessAsync(request, await remoteVideos.GetDiagnosticsAsync(source.Token), source.Token);
                    break;
                case "crypto_provider.get":
                    await writer.SuccessAsync(request, await GetCryptoProviderConfigurationAsync(source.Token), source.Token);
                    break;
                case "crypto_provider.save": {
                    var configuration = ReadCryptoProviderConfiguration(request.Payload);
                    await SaveCryptoProviderConfigurationAsync(configuration, source.Token);
                    await writer.SuccessAsync(request, configuration, source.Token);
                    break;
                }
                case "crypto_provider.check":
                    await HandleCryptoProviderCheckAsync(request, source.Token);
                    break;
                case "appearance.get":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new GetAppearanceConfigurationQuery(), source.Token), source.Token);
                    break;
                case "appearance.save": {
                    if (!request.Payload.TryGetProperty("configuration", out var appearanceElement)) throw new ArgumentException("缺少 configuration。");
                    var configuration = appearanceElement.Deserialize<AppearanceConfigurationDto>(JsonOptions) ?? throw new ArgumentException("外观设置字段不完整。");
                    await HandleResultAsync(request, await domains.HandleAsync(new SaveAppearanceConfigurationCommand(configuration), source.Token), source.Token);
                    break;
                }
                case "disturbance_settings.get":
                    await writer.SuccessAsync(request, await proactive.HandleAsync(new GetDisturbanceSettingsQuery(), source.Token)
                        ?? new DisturbanceSettingsDto("normal", true, "01:00", "09:00", true, 3, DateTimeOffset.Now), source.Token);
                    break;
                case "disturbance_settings.save": {
                    if (!request.Payload.TryGetProperty("settings", out var disturbanceElement)) throw new ArgumentException("缺少 settings。");
                    var disturbance = disturbanceElement.Deserialize<DisturbanceSettingsDto>(JsonOptions)
                        ?? throw new ArgumentException("勿扰设置字段不完整。");
                    await HandleResultAsync(request, await proactive.HandleAsync(new SaveDisturbanceSettingsCommand(disturbance), source.Token), source.Token);
                    break;
                }
                case "proactive.sources.list":
                    await writer.SuccessAsync(request, await proactiveRuntime.ListSourcesAsync(source.Token), source.Token);
                    break;
                case "proactive.source.update": {
                    var enabled = request.Payload.TryGetProperty("enabled", out var enabledElement) &&
                                  enabledElement.ValueKind is JsonValueKind.True or JsonValueKind.False
                        ? enabledElement.GetBoolean()
                        : (bool?)null;
                    var cooldown = request.Payload.TryGetProperty("cooldownMinutes", out var cooldownElement) &&
                                   cooldownElement.TryGetInt32(out var parsedCooldown)
                        ? parsedCooldown
                        : (int?)null;
                    await HandleValueResultAsync(request, await proactiveRuntime.UpdateSourceAsync(
                        ReadRequiredString(request.Payload, "sourceKey"), enabled, cooldown, source.Token), source.Token);
                    break;
                }
                case "proactive.source.test":
                    await HandleResultAsync(request, await proactiveRuntime.TestSourceAsync(
                        ReadRequiredString(request.Payload, "sourceKey"), source.Token), source.Token);
                    break;
                case "proactive.execution.completed": {
                    var completed = request.Payload.Deserialize<ProactiveExecutionCompletedPayload>(JsonOptions)
                        ?? throw new ArgumentException("主动行为执行完成字段不完整。");
                    await HandleResultAsync(request, await proactiveRuntime.CompleteAsync(new CompleteProactiveExecutionCommand(
                        completed.ExecutionId,
                        completed.Responded,
                        completed.Spoke,
                        completed.Message ?? string.Empty,
                        completed.VoiceTrigger ?? string.Empty,
                        completed.AudioPath ?? string.Empty,
                        completed.Result ?? string.Empty,
                        completed.Error ?? string.Empty,
                        completed.CompletedAt), source.Token), source.Token);
                    break;
                }
                case "proactive.state.apply":
                    await HandleResultAsync(request, await proactiveRuntime.ApplyStateAsync(
                        ReadString(request.Payload, "mood"),
                        request.Payload.TryGetProperty("favorabilityDelta", out var deltaElement) &&
                        deltaElement.TryGetInt32(out var delta) ? delta : 0,
                        source.Token), source.Token);
                    break;
                case "model.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListModelConfigurationsQuery(), source.Token), source.Token);
                    break;
                case "model.save":
                    await HandleResultAsync(request, await domains.HandleAsync(new SaveModelConfigurationsCommand(
                        ReadArray<ModelConfigurationDto>(request.Payload, "configurations")), source.Token), source.Token);
                    break;
                case "model.add":
                    await HandleResultAsync(request, await domains.HandleAsync(new AddModelConfigurationCommand(
                        ReadRequiredString(request.Payload, "modelKey"), ReadRequiredString(request.Payload, "modelType")), source.Token), source.Token);
                    break;
                case "business_model.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListLlmBusinessModelConfigsQuery(), source.Token), source.Token);
                    break;
                case "business_model.save":
                    await HandleResultAsync(request, await domains.HandleAsync(new SaveLlmBusinessModelConfigsCommand(
                        ReadArray<LlmBusinessModelConfigDto>(request.Payload, "configurations")), source.Token), source.Token);
                    break;
                case "source_prompt.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListLlmSourcePromptsQuery(), source.Token), source.Token);
                    break;
                case "source_prompt.save":
                    await HandleResultAsync(request, await domains.HandleAsync(new SaveLlmSourcePromptCommand(
                        ReadObject<LlmSourcePromptDto>(request.Payload, "prompt")), source.Token), source.Token);
                    break;
                case "reminder.list":
                    await writer.SuccessAsync(request, await reminders.HandleAsync(new ListRemindersQuery(), source.Token), source.Token);
                    break;
                case "reminder.save":
                    await HandleReminderSaveAsync(request, source.Token);
                    break;
                case "reminder.delete":
                    await HandleResultAsync(request, await reminders.HandleAsync(new DeleteReminderCommand(ReadRequiredString(request.Payload, "reminderId")), source.Token), source.Token);
                    break;
                case "reminder.set_enabled":
                    await HandleValueResultAsync(request, await reminders.HandleAsync(new SetReminderEnabledCommand(ReadRequiredString(request.Payload, "reminderId"), ReadBoolean(request.Payload, "enabled")), source.Token), source.Token);
                    break;
                case "reminder.set_allow_tts":
                    await HandleValueResultAsync(request, await reminders.HandleAsync(new SetReminderAllowTtsCommand(ReadRequiredString(request.Payload, "reminderId"), ReadBoolean(request.Payload, "allowTts")), source.Token), source.Token);
                    break;
                case "reminder.process_due":
                    await HandleDueRemindersAsync(request, source.Token);
                    break;
                case "reminder.delivery.completed": {
                    var payload = request.Payload.Deserialize<ReminderDeliveryCompletedPayload>(JsonOptions)
                        ?? throw new ArgumentException("提醒交付完成字段不完整。");
                    await HandleResultAsync(request, await reminders.HandleAsync(new CompleteReminderDeliveryCommand(
                        payload.DeliveryId,
                        payload.ReminderId,
                        payload.NotificationShown,
                        payload.BubbleShown,
                        payload.TtsRequested,
                        payload.TtsPlayed,
                        payload.Result ?? string.Empty,
                        payload.Error ?? string.Empty,
                        payload.CompletedAt), source.Token), source.Token);
                    break;
                }
                case "character.list":
                    await writer.SuccessAsync(request, await characters.HandleAsync(new ListCharactersQuery(true), source.Token), source.Token);
                    break;
                case "character.set_current":
                    await HandleResultAsync(request, await characters.HandleAsync(new SetCurrentCharacterCommand(ReadRequiredString(request.Payload, "roleId")), source.Token), source.Token);
                    break;
                case "character.save":
                    await HandleCharacterSaveAsync(request, source.Token);
                    break;
                case "character.delete":
                    await HandleResultAsync(request, await characters.HandleAsync(new DeleteCharacterCommand(ReadRequiredString(request.Payload, "roleId")), source.Token), source.Token);
                    break;
                case "character.voice_assets":
                    await writer.SuccessAsync(request, await characterAssets.HandleAsync(new ListVoiceAssetsQuery(), source.Token), source.Token);
                    break;
                case "character.voice_asset.add":
                    await HandleValueResultAsync(request, await characterAssets.HandleAsync(new AddVoiceAssetCommand(
                        ReadRequiredString(request.Payload, "baseName"), ReadString(request.Payload, "displayName"),
                        ReadRequiredString(request.Payload, "style"), ReadRequiredString(request.Payload, "sourceFolderPath")), source.Token), source.Token);
                    break;
                case "character.avatar.import":
                    await HandleValueResultAsync(request, await characterAssets.HandleAsync(new ImportCharacterAvatarCommand(
                        ReadRequiredString(request.Payload, "sourcePath")), source.Token), source.Token);
                    break;
                case "character.voices":
                    await writer.SuccessAsync(request, await characterAssets.HandleAsync(new ListRoleVoicesQuery(
                        ReadRequiredString(request.Payload, "roleId")), source.Token), source.Token);
                    break;
                case "character.voices.set":
                    await HandleResultAsync(request, await characterAssets.HandleAsync(new SetRoleVoicesCommand(
                        ReadRequiredString(request.Payload, "roleId"), ReadArray<RoleVoiceDto>(request.Payload, "voices")), source.Token), source.Token);
                    break;
                case "character.binding.get":
                    await writer.SuccessAsync(request, await characterAssets.HandleAsync(new GetCharacterObjectBindingQuery(
                        ReadRequiredString(request.Payload, "targetKey")), source.Token), source.Token);
                    break;
                case "character.binding.list":
                    await writer.SuccessAsync(request, await characterAssets.HandleAsync(new ListCharacterObjectBindingsQuery(
                        ReadRequiredString(request.Payload, "roleId")), source.Token), source.Token);
                    break;
                case "character.binding.set":
                    await HandleValueResultAsync(request, await characterAssets.HandleAsync(new BindCharacterObjectCommand(
                        ReadRequiredString(request.Payload, "targetKey"), ReadRequiredString(request.Payload, "roleId")), source.Token), source.Token);
                    break;
                case "character.binding.clear":
                    await HandleResultAsync(request, await characterAssets.HandleAsync(new UnbindCharacterObjectCommand(
                        ReadRequiredString(request.Payload, "targetKey")), source.Token), source.Token);
                    break;
                case "character.binding.apply":
                    await HandleResultAsync(request, await characterAssets.HandleAsync(new ApplyCharacterObjectBindingCommand(
                        ReadRequiredString(request.Payload, "targetKey")), source.Token), source.Token);
                    break;
                case "character.template.generate":
                    await HandleValueResultAsync(request, await templateCards.HandleAsync(new GenerateTemplateCardCommand(
                        ReadRequiredString(request.Payload, "roleId"), ReadBoolean(request.Payload, "continueIteration")), source.Token), source.Token);
                    break;
                case "agent.capabilities.list":
                    await writer.SuccessAsync(request, await agent.HandleAsync(new ListAgentCapabilitiesQuery(
                        ReadBoolean(request.Payload, "enabledOnly")), source.Token), source.Token);
                    break;
                case "agent.capability.save":
                    await HandleResultAsync(request, await agent.HandleAsync(new SaveAgentCapabilityCommand(
                        ReadObject<AgentCapabilityDto>(request.Payload, "capability")), source.Token), source.Token);
                    break;
                case "agent.execute":
                    await HandleAgentExecuteAsync(request, source.Token);
                    break;
                case "agent.decide":
                    await HandleValueResultAsync(request, await agent.HandleAsync(new DecideAgentInputCommand(
                        ReadRequiredString(request.Payload, "content"),
                        ReadOptionalString(request.Payload, "conversationId"),
                        ReadOptionalString(request.Payload, "characterId"),
                        ReadBoolean(request.Payload, "saveUserMessage"),
                         ReadOptionalString(request.Payload, "toolResultJson") ?? "{}",
                        ReadInt(request.Payload, "toolStep", 1, 20, 1),
                        ReadInt(request.Payload, "maxSteps", 1, 20, 4),
                        ReadOptionalString(request.Payload, "source") ?? "normal_chat",
                        ReadOptionalBoolean(request.Payload, "continueConversation")), source.Token), source.Token);
                    break;
                case "pet.voice_menu.get":
                    await writer.SuccessAsync(request, await petVoiceMenu.GetAsync(source.Token), source.Token);
                    break;
                case "pet.voice_intimacy.cycle":
                    await HandleValueResultAsync(request, await petVoiceMenu.CycleAsync(source.Token), source.Token);
                    break;
                case "pet.voice_cache.clear":
                    await HandleValueResultAsync(request, await petVoiceMenu.ClearCurrentCacheAsync(source.Token), source.Token);
                    break;
                case "pet.voice_cache.ensure":
                    await HandleValueResultAsync(request, await petVoiceMenu.EnsureCurrentCacheAsync(
                        request.Payload.TryGetProperty("includeNextPeriod", out _) ? ReadBoolean(request.Payload, "includeNextPeriod") : true,
                        ReadOptionalBoolean(request.Payload, "forceRefresh"),
                        source.Token), source.Token);
                    break;
                case "pet.voice.play":
                    await HandleValueResultAsync(request, await petVoiceMenu.ResolvePlaybackAsync(new AIMaid.Contracts.PetVoice.PlayPetVoiceCommand(
                        ReadOptionalString(request.Payload, "triggerId") ?? "click",
                        ReadOptionalString(request.Payload, "bodyPart") ?? "body",
                        ReadOptionalString(request.Payload, "source") ?? "pet.click",
                        ReadOptionalString(request.Payload, "hitAreaName") ?? "",
                        ReadOptionalDouble(request.Payload, "normalizedX"), ReadOptionalDouble(request.Payload, "normalizedY")), source.Token), source.Token);
                    break;
                case "pet.voice.playback.report":
                    await petVoiceMenu.ReportPlaybackAsync(new AIMaid.Contracts.PetVoice.ReportPetVoicePlaybackCommand(
                        ReadRequiredString(request.Payload, "triggerId"),
                        ReadOptionalString(request.Payload, "bodyPart") ?? "body",
                        ReadOptionalString(request.Payload, "text") ?? "",
                        ReadOptionalString(request.Payload, "audioPath") ?? "",
                        ReadBoolean(request.Payload, "played"),
                        ReadOptionalString(request.Payload, "reason") ?? "",
                        ReadOptionalString(request.Payload, "source") ?? "pet.click",
                        ReadOptionalString(request.Payload, "generationId") ?? "", ReadOptionalString(request.Payload, "contextHash") ?? "",
                        ReadOptionalString(request.Payload, "category") ?? "", ReadOptionalString(request.Payload, "hitAreaName") ?? "",
                        ReadOptionalDouble(request.Payload, "normalizedX"), ReadOptionalDouble(request.Payload, "normalizedY")), source.Token);
                    await writer.SuccessAsync(request, new { saved = true }, source.Token);
                    break;
                case "music.current":
                    await writer.SuccessAsync(request, music.Current(), source.Token);
                    break;
                case "music.search_and_play":
                    await HandleValueResultAsync(request, await music.SearchAndPlayAsync(
                        ReadRequiredString(request.Payload, "songName"), source.Token), source.Token);
                    break;
                case "music.toggle_pause":
                    await HandleValueResultAsync(request, await music.TogglePauseAsync(source.Token), source.Token);
                    break;
                case "music.stop":
                    await music.StopAsync(source.Token);
                    await writer.SuccessAsync(request, new { stopped = true }, source.Token);
                    break;
                case "market.symbols":
                    await writer.SuccessAsync(request, await market.ListSymbolsAsync(source.Token), source.Token);
                    break;
                case "market.snapshot":
                    await writer.SuccessAsync(request, await market.GetSnapshotAsync(ReadRequiredString(request.Payload, "symbol"), source.Token), source.Token);
                    break;
                case "market.chart_snapshot":
                    await writer.SuccessAsync(request, await market.GetChartAsync(
                        ReadRequiredString(request.Payload, "symbol"),
                        ReadRequiredString(request.Payload, "interval"),
                        request.Payload.TryGetProperty("emaPeriods", out var emaElement) && emaElement.ValueKind == JsonValueKind.Array
                            ? emaElement.EnumerateArray().Where(item => item.TryGetInt32(out _)).Select(item => item.GetInt32()).ToArray()
                            : [7, 25], source.Token), source.Token);
                    break;
                case "market.list":
                    await writer.SuccessAsync(request, await domains.HandleAsync(new ListMarketEventsQuery(
                        TryGetString(request.Payload, "symbol", out var marketSymbol) ? marketSymbol : null,
                        request.Payload.TryGetProperty("limit", out var limitElement) && limitElement.TryGetInt32(out var limit) ? limit : 100), source.Token), source.Token);
                    break;
                case "market.record":
                    await HandleResultAsync(request, await domains.HandleAsync(new RecordMarketEventCommand(
                        ReadObject<MarketEventDto>(request.Payload, "marketEvent")), source.Token), source.Token);
                    break;
                case "status.resources":
                    await writer.SuccessAsync(request, await status.GetResourcesAsync(source.Token), source.Token);
                    break;
                case "status.network":
                    await writer.SuccessAsync(request, await status.GetNetworkAsync(source.Token), source.Token);
                    break;
                case "status.role":
                    await writer.SuccessAsync(request, await status.GetRoleStateAsync(source.Token), source.Token);
                    break;
                case "status.tts":
                    await writer.SuccessAsync(request, await ttsRuntime.GetStatusAsync(source.Token), source.Token);
                    break;
                case "status.llm_latencies":
                    await writer.SuccessAsync(request, await status.GetLlmLatenciesAsync(
                        ReadString(request.Payload, "chatModel"), ReadString(request.Payload, "cacheModel"),
                        ReadString(request.Payload, "proactiveModel"), source.Token), source.Token);
                    break;
                case "status.server.health":
                    await writer.SuccessAsync(request, await statusServers.GetHealthAsync(source.Token), source.Token);
                    break;
                case "status.server.summary":
                    await writer.SuccessAsync(request, await statusServers.GetSummaryAsync(source.Token), source.Token);
                    break;
                case "status.codex_quota":
                    await writer.SuccessAsync(request, await codexQuota.GetAsync(source.Token), source.Token);
                    break;
                case "tts.playback.set":
                    ttsRuntime.SetPlaybackActive(ReadBoolean(request.Payload, "playing"));
                    await writer.SuccessAsync(request, new { accepted = true }, source.Token);
                    break;
                case "system.stream":
                    await HandleStreamAsync(request, source.Token);
                    break;
            }
            Log("info", "request_end", request.Id, request.Type, "completed", stopwatch.Elapsed.TotalMilliseconds,
                "Core request completed", new { activeRequests = active.Count });
        }
        catch (OperationCanceledException)
        {
            await writer.EventAsync("request.cancelled", request.Id, 1, new { requestId = request.Id }, CancellationToken.None);
            Log("warn", "request_cancel", request.Id, request.Type, "cancelled", stopwatch.Elapsed.TotalMilliseconds,
                "Core request cancelled");
        }
        catch (RemoteVideoOperationException exception)
        {
            await writer.FailureAsync(request, "REMOTE_VIDEO_OPERATION_FAILED", exception.Message, cancellationToken: CancellationToken.None);
            Log("warn", "request_end", request.Id, request.Type, "failed", stopwatch.Elapsed.TotalMilliseconds,
                "Remote video operation failed", exception: exception);
        }
        catch (AiProviderRequestException exception)
        {
            var statusCode = exception.StatusCode is null ? null : (int?)exception.StatusCode.Value;
            await writer.FailureAsync(request, "LLM_UPSTREAM_ERROR",
                statusCode is null
                    ? "无法连接 LLM 服务，详细原因已写入日志。"
                    : $"LLM 服务请求失败（HTTP {statusCode}），详细原因已写入日志。",
                new Dictionary<string, object?> { ["statusCode"] = statusCode }, CancellationToken.None);
            Log("error", "request_end", request.Id, request.Type, "failed", stopwatch.Elapsed.TotalMilliseconds,
                "LLM upstream request failed", new { upstreamStatusCode = statusCode }, exception);
        }
        catch (ArgumentException exception)
        {
            await writer.FailureAsync(request, "INVALID_ARGUMENT", exception.Message, cancellationToken: CancellationToken.None);
            Log("warn", "request_end", request.Id, request.Type, "invalid", stopwatch.Elapsed.TotalMilliseconds,
                "Core request rejected as invalid", exception: exception);
        }
        catch (Exception exception)
        {
            await writer.FailureAsync(request, "INTERNAL_ERROR", "Core 请求处理失败。", cancellationToken: CancellationToken.None);
            Log("error", "request_end", request.Id, request.Type, "failed", stopwatch.Elapsed.TotalMilliseconds,
                "Core request failed", exception: exception);
        }
        finally
        {
            active.TryRemove(request.Id, out _);
            MarkCompleted(request.Id);
            source.Dispose();
        }
    }

    private void MarkCompleted(string requestId)
    {
        recentlyCompleted[requestId] = DateTimeOffset.UtcNow;
    }

    private void PruneRecentlyCompleted()
    {
        var cutoff = DateTimeOffset.UtcNow - RecentRequestRetention;
        foreach (var pair in recentlyCompleted)
            if (pair.Value < cutoff) recentlyCompleted.TryRemove(pair.Key, out _);
    }

    private async Task HandleCharacterSaveAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        if (!request.Payload.TryGetProperty("character", out var element) || element.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("character.save 缺少角色数据。");
        var character = element.Deserialize<CharacterDto>(JsonOptions)
            ?? throw new ArgumentException("character.save 角色数据无效。");
        await HandleResultAsync(request, await characters.HandleAsync(new UpdateCharacterCommand(character), cancellationToken), cancellationToken);
    }

    private async Task HandleAgentExecuteAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var command = new ExecuteAgentCapabilityCommand(
            ReadRequiredString(request.Payload, "conversationId"),
            ReadRequiredString(request.Payload, "capabilityName"),
            ReadRequiredString(request.Payload, "argsJson"),
            ReadOptionalString(request.Payload, "approvalToken"));
        var result = await agent.HandleAsync(command, cancellationToken);
        if (result.Succeeded && result.Value is not null)
        {
            await writer.SuccessAsync(request, result.Value, cancellationToken);
            return;
        }
        if (result.ErrorCode == "agent.approval_required")
        {
            var capability = (await agent.HandleAsync(new ListAgentCapabilitiesQuery(true), cancellationToken))
                .First(item => item.CapabilityName.Equals(command.CapabilityName, StringComparison.OrdinalIgnoreCase));
            await writer.FailureAsync(request, result.ErrorCode, "该能力需要用户确认。", new Dictionary<string, object?>
            {
                ["approvalToken"] = result.ErrorMessage,
                ["capabilityName"] = capability.CapabilityName,
                ["displayName"] = capability.DisplayName,
                ["description"] = capability.Description,
                ["executorType"] = capability.ExecutorType,
                ["riskLevel"] = capability.RiskLevel,
                ["argsJson"] = string.IsNullOrWhiteSpace(command.ArgsJson)
                    ? null
                    : JsonSerializer.Deserialize<JsonElement>(command.ArgsJson)
            }, cancellationToken);
            return;
        }
        await writer.FailureAsync(request, result.ErrorCode ?? "agent.failed", result.ErrorMessage ?? "Agent 执行失败。", cancellationToken: cancellationToken);
    }

    private async Task HandleHandshakeAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        if (ready)
        {
            await writer.FailureAsync(request, "PROTOCOL_DUPLICATE_REQUEST", "握手已经完成。", cancellationToken: cancellationToken);
            return;
        }
        if (!TryGetString(request.Payload, "desktopVersion", out var desktopVersion) ||
            !TryGetString(request.Payload, "platform", out var platform) ||
            !TryGetString(request.Payload, "arch", out var arch))
        {
            await writer.FailureAsync(request, "INVALID_ARGUMENT", "握手字段不完整。", cancellationToken: cancellationToken);
            return;
        }
        ready = true;
        await proactiveRuntime.StartAsync(cancellationToken);
        var payload = new
        {
            coreVersion,
            protocolVersion = ProtocolConstants.Version,
            capabilities = ProtocolRequestRegistry.Capabilities,
            platform = Environment.OSVersion.Platform.ToString(),
            arch = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
            desktopVersion
        };
        await writer.SuccessAsync(request, payload, cancellationToken);
        await writer.EventAsync("core.ready", request.Id, 0, payload, cancellationToken);
        Log("info", "handshake", request.Id, request.Type, "ready", message: "Core handshake completed",
            data: new { platform, arch, desktopVersion, coreVersion, protocolVersion = ProtocolConstants.Version });
    }

    private async Task HandleSettingsGetAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var keys = ReadSettingKeys(request.Payload);
        var values = await settings.HandleAsync(new GetSettingsQuery(keys), cancellationToken);
        await writer.SuccessAsync(request, new { settings = values }, cancellationToken);
    }

    private const string CryptoProviderSettingKey = "crypto_market_provider_config";
    private async Task<CryptoProviderConfigurationDto> GetCryptoProviderConfigurationAsync(CancellationToken cancellationToken)
    {
        var value = (await settingsStore.GetAsync(CryptoProviderSettingKey, cancellationToken))?.Value;
        return string.IsNullOrWhiteSpace(value) ? new(false, string.Empty, 8, "未检测", null, null)
            : JsonSerializer.Deserialize<CryptoProviderConfigurationDto>(value, JsonOptions) ?? new(false, string.Empty, 8, "未检测", null, null);
    }
    private Task SaveCryptoProviderConfigurationAsync(CryptoProviderConfigurationDto configuration, CancellationToken cancellationToken)
        => settingsStore.SetManyAsync(new Dictionary<string, string> { [CryptoProviderSettingKey] = JsonSerializer.Serialize(configuration, JsonConfig.Persistence) }, cancellationToken);
    private static CryptoProviderConfigurationDto ReadCryptoProviderConfiguration(JsonElement payload)
        => payload.TryGetProperty("configuration", out var element)
            ? element.Deserialize<CryptoProviderConfigurationDto>(JsonOptions) ?? throw new ArgumentException("行情服务配置无效。")
            : throw new ArgumentException("缺少 configuration。");
    private async Task HandleCryptoProviderCheckAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var configuration = ReadCryptoProviderConfiguration(request.Payload);
        if (!Uri.TryCreate(configuration.ServiceUrl.TrimEnd('/') + "/api/crypto-market/health", UriKind.Absolute, out var uri)) throw new ArgumentException("请先填写有效的 AI Provider 地址。");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(configuration.TimeoutSeconds, 1, 120)));
        var started = System.Diagnostics.Stopwatch.StartNew();
        using var client = new HttpClient();
        var json = await client.GetStringAsync(uri, timeout.Token);
        using var document = JsonDocument.Parse(json);
        var data = document.RootElement.GetProperty("data");
        var available = data.GetProperty("available").GetBoolean();
        var latency = data.TryGetProperty("latencyMs", out var latencyElement) ? latencyElement.GetInt64() : started.ElapsedMilliseconds;
        var provider = data.TryGetProperty("provider", out var providerElement) ? providerElement.GetString() ?? "AI Provider" : "AI Provider";
        var updated = configuration with { LastHealthStatus = available ? provider : "不可用", LastHealthLatencyMs = latency, LastCheckedAt = DateTimeOffset.Now };
        await SaveCryptoProviderConfigurationAsync(updated, cancellationToken);
        await writer.SuccessAsync(request, new { available, provider, latencyMs = latency, configuration = updated }, cancellationToken);
    }

    private async Task HandleSettingsSaveAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var values = ReadSettingValues(request.Payload);
        await HandleResultAsync(request, await settings.HandleAsync(new SaveSettingsCommand(values), cancellationToken), cancellationToken);
    }

    private async Task HandleChatHistoryAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var conversationId = TryGetString(request.Payload, "conversationId", out var requestedId)
            ? requestedId
            : (await settingsStore.GetAsync("chat_history_current_conversation_id", cancellationToken))?.Value;
        if (string.IsNullOrWhiteSpace(conversationId))
        {
            conversationId = $"conversation_{Guid.NewGuid():N}";
            await settingsStore.SetManyAsync(new Dictionary<string, string>
            {
                ["chat_history_current_conversation_id"] = conversationId
            }, cancellationToken);
        }
        var limit = ReadInt(request.Payload, "limit", 1, 100, 40);
        var messages = await chatStore.LoadRecentAsync(conversationId, limit, cancellationToken);
        await writer.SuccessAsync(request, new { conversationId, messages }, cancellationToken);
    }

    private async Task HandleNotebookSaveAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        if (!request.Payload.TryGetProperty("note", out var element)) throw new ArgumentException("缺少 note。");
        var note = element.Deserialize<NotebookNoteDto>(JsonOptions)
            ?? throw new ArgumentException("笔记字段不完整。");
        await HandleResultAsync(request, await domains.HandleAsync(new SaveNotebookNoteCommand(note), cancellationToken), cancellationToken);
    }

    private async Task HandleNotebookAttachmentSaveAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var attachment = new SaveNotebookAttachmentCommand(
            ReadRequiredString(request.Payload, "id"), ReadRequiredString(request.Payload, "noteId"),
            ReadString(request.Payload, "originalName"), ReadRequiredString(request.Payload, "storedPath"),
            ReadString(request.Payload, "mimeType"), ReadLong(request.Payload, "sizeBytes", 0, long.MaxValue),
            ReadOptionalInt(request.Payload, "width"), ReadOptionalInt(request.Payload, "height"),
            ReadString(request.Payload, "sha256"), request.Payload.TryGetProperty("createdAt", out var created) && created.TryGetDateTimeOffset(out var parsed) ? parsed : DateTimeOffset.Now);
        await HandleResultAsync(request, await domains.HandleAsync(attachment, cancellationToken), cancellationToken);
    }

    private async Task HandleVoiceConversationSaveAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        if (!request.Payload.TryGetProperty("conversation", out var element)) throw new ArgumentException("缺少 conversation。");
        var conversation = element.Deserialize<VoiceConversationDto>(JsonOptions)
            ?? throw new ArgumentException("会话字段不完整。");
        await HandleResultAsync(request, await domains.HandleAsync(new SaveVoiceConversationCommand(conversation), cancellationToken), cancellationToken);
    }

    private async Task HandleVaultSaveAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        if (!request.Payload.TryGetProperty("item", out var element)) throw new ArgumentException("缺少 item。");
        var item = element.Deserialize<VaultItemDto>(JsonOptions)
            ?? throw new ArgumentException("密码库字段不完整。");
        var plainSecret = request.Payload.TryGetProperty("plainSecret", out var secretElement) && secretElement.ValueKind == JsonValueKind.String
            ? secretElement.GetString()
            : null;
        var changeRemark = request.Payload.TryGetProperty("changeRemark", out var remarkElement) && remarkElement.ValueKind == JsonValueKind.String
            ? remarkElement.GetString()
            : null;
        await HandleValueResultAsync(request, await domains.HandleAsync(new SaveVaultItemCommand(item, plainSecret, changeRemark), cancellationToken), cancellationToken);
    }

    private async Task HandleReminderSaveAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var payload = request.Payload.Deserialize<ReminderSavePayload>(JsonOptions)
            ?? throw new ArgumentException("提醒保存字段不完整。");
        var result = await reminders.HandleAsync(new SaveReminderCommand(payload.ReminderId, payload.Title ?? string.Empty,
            payload.Message ?? string.Empty, payload.DueAt, payload.Repeat ?? "none", payload.Enabled, payload.AllowTts), cancellationToken);
        await HandleValueResultAsync(request, result, cancellationToken);
    }

    private async Task HandleDueRemindersAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var now = request.Payload.TryGetProperty("now", out var element) && element.TryGetDateTimeOffset(out var parsed)
            ? parsed : DateTimeOffset.Now;
        IReadOnlyList<string>? reminderIds = null;
        if (request.Payload.TryGetProperty("reminderIds", out var idsElement))
        {
            reminderIds = idsElement.Deserialize<string[]>(JsonOptions)
                ?? throw new ArgumentException("提醒 ID 列表格式无效。");
            if (reminderIds.Count is < 1 or > 5 || reminderIds.Any(string.IsNullOrWhiteSpace))
                throw new ArgumentException("提醒 ID 列表必须包含 1 到 5 个有效 ID。");
        }
        var notificationShown = request.Payload.TryGetProperty("notificationShown", out var notificationElement) &&
                                notificationElement.ValueKind is JsonValueKind.True or JsonValueKind.False &&
                                notificationElement.GetBoolean();
        var result = await reminders.HandleAsync(new ProcessDueRemindersCommand(now, reminderIds, notificationShown), cancellationToken);
        if (!result.Succeeded) { await writer.FailureAsync(request, result.ErrorCode ?? "reminder.failed", result.ErrorMessage ?? "提醒检查失败。", cancellationToken: cancellationToken); return; }
        await writer.SuccessAsync(request, result.Value ?? [], cancellationToken);
    }

    private async Task HandleResultAsync(ProtocolRequest request, OperationResult result, CancellationToken cancellationToken)
    {
        if (result.Succeeded) await writer.SuccessAsync(request, new { succeeded = true }, cancellationToken);
        else await writer.FailureAsync(request, result.ErrorCode ?? "business.failed", result.ErrorMessage ?? "业务操作失败。", cancellationToken: cancellationToken);
    }

    private async Task HandleValueResultAsync<T>(ProtocolRequest request, OperationResult<T> result, CancellationToken cancellationToken)
    {
        if (result.Succeeded && result.Value is not null) await writer.SuccessAsync(request, result.Value, cancellationToken);
        else await writer.FailureAsync(request, result.ErrorCode ?? "business.failed", result.ErrorMessage ?? "业务操作失败。", cancellationToken: cancellationToken);
    }

    private async Task HandleStreamAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        var steps = ReadInt(request.Payload, "steps", 1, 20, 5);
        var delayMs = ReadInt(request.Payload, "delayMs", 20, 5_000, 150);
        await writer.SuccessAsync(request, new { accepted = true, steps }, cancellationToken);
        for (var sequence = 1; sequence <= steps; sequence++)
        {
            await Task.Delay(delayMs, cancellationToken);
            await writer.EventAsync("system.stream.progress", request.Id, sequence,
                new { current = sequence, total = steps, progress = (double)sequence / steps }, cancellationToken);
        }
        await writer.EventAsync("system.stream.completed", request.Id, steps + 1,
            new { total = steps }, cancellationToken);
    }

    private async Task HandleCancelAsync(ProtocolRequest request, CancellationToken cancellationToken)
    {
        if (!TryGetString(request.Payload, "requestId", out var targetId))
        {
            await writer.FailureAsync(request, "INVALID_ARGUMENT", "缺少 requestId。", cancellationToken: cancellationToken);
            return;
        }
        var cancelled = active.TryGetValue(targetId, out var source);
        source?.Cancel();
        await writer.SuccessAsync(request, new { requestId = targetId, cancelled }, cancellationToken);
    }

    private (ProtocolRequest? Request, string? ErrorCode) Parse(string line)
    {
        try
        {
            var request = JsonSerializer.Deserialize<ProtocolRequest>(line, JsonOptions);
            if (request is null || request.Kind != "request" || string.IsNullOrWhiteSpace(request.Id) ||
                request.Id.Length is < 8 or > 100 || string.IsNullOrWhiteSpace(request.Type) ||
                request.Payload.ValueKind is JsonValueKind.Undefined)
            {
                Log("warn", "protocol_error", request?.Id, request?.Type, "invalid_envelope", message: "Invalid protocol envelope");
                return (null, "PROTOCOL_INVALID_ENVELOPE");
            }
            return (request, null);
        }
        catch (JsonException exception)
        {
            Log("warn", "protocol_error", null, null, "invalid_json", message: "Invalid protocol JSON", exception: exception);
            return (null, "PROTOCOL_INVALID_JSON");
        }
    }

    private static IReadOnlyList<string> ReadSettingKeys(JsonElement payload)
    {
        if (!payload.TryGetProperty("keys", out var element) || element.ValueKind == JsonValueKind.Null)
            return DefaultSafeSettingKeys;
        if (element.ValueKind != JsonValueKind.Array) throw new ArgumentException("keys 必须是字符串数组。");
        var keys = element.EnumerateArray().Select(value => value.GetString() ?? string.Empty).ToArray();
        if (keys.Length > 50 || keys.Any(key => string.IsNullOrWhiteSpace(key) || key.Length > 100 || IsSensitiveKey(key)))
            throw new ArgumentException("settings.get 包含无效或敏感设置键。");
        return keys;
    }

    private static IReadOnlyDictionary<string, string> ReadSettingValues(JsonElement payload)
    {
        if (!payload.TryGetProperty("values", out var element) || element.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("values 必须是字符串对象。");

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in element.EnumerateObject())
        {
            if (values.Count >= 50 || string.IsNullOrWhiteSpace(property.Name) || property.Name.Length > 100 ||
                IsSensitiveKey(property.Name) || property.Value.ValueKind != JsonValueKind.String)
                throw new ArgumentException("settings.save 包含无效或敏感设置键。");
            var value = property.Value.GetString() ?? string.Empty;
            if (value.Length > 4096) throw new ArgumentException("settings.save 设置值过长。");
            values[property.Name] = value;
        }
        if (values.Count == 0) throw new ArgumentException("settings.save 至少需要一个设置值。");
        return values;
    }

    private static bool IsSensitiveKey(string key)
    {
        var tokens = key.Split(new[] { '_', '-', ':', '.' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Any(token => token.Equals("key", StringComparison.OrdinalIgnoreCase) ||
                                token.Equals("token", StringComparison.OrdinalIgnoreCase) ||
                                token.Equals("secret", StringComparison.OrdinalIgnoreCase) ||
                                token.Equals("password", StringComparison.OrdinalIgnoreCase) ||
                                token.Equals("cookie", StringComparison.OrdinalIgnoreCase) ||
                                token.Equals("credential", StringComparison.OrdinalIgnoreCase)))
            return true;

        var compact = string.Concat(tokens);
        return compact.Equals("apikey", StringComparison.OrdinalIgnoreCase) ||
               compact.Equals("accesskey", StringComparison.OrdinalIgnoreCase) ||
               compact.Equals("secretkey", StringComparison.OrdinalIgnoreCase) ||
               compact.Equals("privatekey", StringComparison.OrdinalIgnoreCase);
    }

    private static int ReadInt(JsonElement payload, string name, int minimum, int maximum, int fallback)
        => payload.TryGetProperty(name, out var element) && element.TryGetInt32(out var value)
            ? Math.Clamp(value, minimum, maximum)
            : fallback;

    private static int? ReadOptionalInt(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var element) && element.TryGetInt32(out var value) ? value : null;

    private static long ReadLong(JsonElement payload, string name, long minimum, long maximum)
        => payload.TryGetProperty(name, out var element) && element.TryGetInt64(out var value) && value >= minimum && value <= maximum
            ? value
            : throw new ArgumentException($"缺少或无效的 {name}。");

    private static double ReadDouble(JsonElement payload, string name, bool positive = false)
        => payload.TryGetProperty(name, out var element) && element.TryGetDouble(out var value) && double.IsFinite(value) && (!positive || value > 0)
            ? value
            : throw new ArgumentException($"缺少或无效的 {name}。");

    private static bool TryGetString(JsonElement payload, string name, out string value)
    {
        value = payload.TryGetProperty(name, out var element) ? element.GetString() ?? string.Empty : string.Empty;
        return !string.IsNullOrWhiteSpace(value);
    }

    private static double? ReadOptionalDouble(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var parsed)
            ? parsed : null;

    private static string ReadRequiredString(JsonElement payload, string name)
        => TryGetString(payload, name, out var value) ? value : throw new ArgumentException($"缺少 {name}。");
    private static string ReadString(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String ? element.GetString() ?? string.Empty : string.Empty;
    private static string? ReadOptionalString(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(element.GetString()) ? element.GetString() : null;
    private static IReadOnlyList<string> ReadStringArray(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.Array) throw new ArgumentException($"缺少或无效的 {name}。");
        var values = element.EnumerateArray().Select(value => value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty).ToArray();
        if (values.Length is < 1 or > 1000 || values.Any(string.IsNullOrWhiteSpace)) throw new ArgumentException($"{name} 必须包含 1 到 1000 个有效 ID。");
        return values;
    }
    private static IReadOnlyList<T> ReadArray<T>(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Array
            ? element.Deserialize<T[]>(JsonOptions) ?? throw new ArgumentException($"{name} 无效。")
            : throw new ArgumentException($"缺少 {name}。");
    private static T ReadObject<T>(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Object
            ? element.Deserialize<T>(JsonOptions) ?? throw new ArgumentException($"{name} 无效。")
            : throw new ArgumentException($"缺少 {name}。");
    private static bool ReadBoolean(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var element) && element.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? element.GetBoolean() : throw new ArgumentException($"缺少或无效的 {name}。");
    private static bool ReadOptionalBoolean(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var element) && element.ValueKind is JsonValueKind.True or JsonValueKind.False && element.GetBoolean();

    private sealed record ReminderSavePayload(string? ReminderId, string? Title, string? Message, DateTimeOffset DueAt, string? Repeat, bool Enabled, bool AllowTts);
    private sealed record ReminderDeliveryCompletedPayload(
        string DeliveryId,
        string ReminderId,
        bool NotificationShown,
        bool BubbleShown,
        bool TtsRequested,
        bool TtsPlayed,
        string? Result,
        string? Error,
        DateTimeOffset CompletedAt);
    private sealed record ProactiveExecutionCompletedPayload(
        string ExecutionId,
        bool Responded,
        bool Spoke,
        string? Message,
        string? VoiceTrigger,
        string? AudioPath,
        string? Result,
        string? Error,
        DateTimeOffset CompletedAt);

    private void Log(string level, string eventName, string? requestId, string? type, string status,
        double? durationMs = null, string? message = null, object? data = null, Exception? exception = null)
        => CoreLog.Write(error, level, eventName, message ?? eventName, requestId, type, status, durationMs, data, exception);
}
