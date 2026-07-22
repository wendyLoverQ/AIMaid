using AIMaid.Contracts;
using AIMaid.Contracts.Settings;

namespace AIMaid.Core;

public sealed class SettingsApplicationService :
    ICommandHandler<SaveSettingCommand, OperationResult>,
    ICommandHandler<SaveSettingsCommand, OperationResult>,
    IQueryHandler<GetSettingQuery, SettingDto?>,
    IQueryHandler<GetSettingsQuery, IReadOnlyList<SettingDto>>
{
    private readonly ISettingsStore store;
    private readonly IEventPublisher events;

    public SettingsApplicationService(ISettingsStore store, IEventPublisher events)
    {
        this.store = store;
        this.events = events;
    }

    public async Task<SettingDto?> HandleAsync(GetSettingQuery query, CancellationToken cancellationToken = default)
        => await store.GetAsync(query.Key, cancellationToken) ?? DefaultSetting(query.Key);

    public async Task<IReadOnlyList<SettingDto>> HandleAsync(GetSettingsQuery query, CancellationToken cancellationToken = default)
    {
        var saved = await store.GetManyAsync(query.Keys, cancellationToken);
        if (query.Keys is null) return saved;
        var values = saved.ToDictionary(item => item.Key, StringComparer.OrdinalIgnoreCase);
        foreach (var key in query.Keys)
            if (!values.ContainsKey(key) && DefaultSetting(key) is { } fallback) values[key] = fallback;
        return values.Values.OrderBy(item => item.Key, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public Task<OperationResult> HandleAsync(SaveSettingCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(new Dictionary<string, string> { [command.Key] = command.Value }, cancellationToken);

    public Task<OperationResult> HandleAsync(SaveSettingsCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(command.Values, cancellationToken);

    private async Task<OperationResult> SaveAsync(IReadOnlyDictionary<string, string> values, CancellationToken cancellationToken)
    {
        if (values.Count == 0 || values.Keys.Any(string.IsNullOrWhiteSpace))
            return OperationResult.Failure("settings.invalid", "配置键不能为空。");
        foreach (var (key, value) in values)
        {
            var validation = Validate(key, value);
            if (validation is not null) return validation;
        }
        await store.SetManyAsync(values, cancellationToken);
        await events.PublishAsync(new SettingsChangedEvent(EventIdentity.NewId(), DateTimeOffset.Now, values.Keys.ToArray()), cancellationToken);
        // TODO(UI): 保存页根据配置元数据展示“立即生效/重启后生效”，并显示明确保存反馈。
        return OperationResult.Success();
    }

    private static OperationResult? Validate(string key, string rawValue)
    {
        var value = rawValue.Trim();
        if (key is "realtime_tts_enabled" or "ai_proactive_enabled" or "start_with_windows" && !bool.TryParse(value, out _))
            return OperationResult.Failure("settings.invalid_boolean", $"配置“{key}”必须是 true 或 false。");
        if (key == "master_audio_muted" && !bool.TryParse(value, out _))
            return OperationResult.Failure("settings.invalid_boolean", "主音量静音值必须是 true 或 false。");
        if (key == "master_audio_volume" && (!int.TryParse(value, out var volume) || volume is < 0 or > 100))
            return OperationResult.Failure("settings.invalid_volume", "主音量必须在 0 到 100 之间。");
        if (key == "ui_language" && value is not ("zh-CN" or "en" or "es" or "ja"))
            return OperationResult.Failure("settings.invalid_language", "界面语言必须是 zh-CN、en、es 或 ja。");
        if (key == "comic_bubble_style" && value is not ("" or "normal" or "soft" or "lively" or "close"))
            return OperationResult.Failure("settings.invalid_bubble_style", "气泡主题值无效。");
        if (key == "music_visualizer_style" && value is not ("surround-bars" or "surround-line" or "bottom-wave"))
            return OperationResult.Failure("settings.invalid_music_visualizer_style", "音乐音浪样式值无效。");
        if (key == "disturbance_mode" && value is not ("normal" or "quiet" or "focus" or "game" or "sleep"))
            return OperationResult.Failure("settings.invalid_disturbance", "勿扰模式值无效。");
        if (key == "voice_cache_period_hours" && (!int.TryParse(value, out var hours) || hours is not (1 or 2 or 4 or 8 or 16)))
            return OperationResult.Failure("settings.invalid_cache_period", "语音缓存周期只能是 1、2、4、8 或 16 小时。");
        if (key.StartsWith("hotkey_", StringComparison.OrdinalIgnoreCase) && value.Length > 80)
            return OperationResult.Failure("settings.invalid_hotkey", "快捷键文本过长。");
        if (!key.StartsWith("user_config:", StringComparison.OrdinalIgnoreCase)) return null;

        var configurationKey = key["user_config:".Length..];
        if (BooleanUserConfigurationKeys.Contains(configurationKey) && !bool.TryParse(value, out _))
            return OperationResult.Failure("settings.invalid_boolean", $"配置“{configurationKey}”必须是 true 或 false。");
        if (IntegerUserConfigurationKeys.Contains(configurationKey) && !int.TryParse(value, out _))
            return OperationResult.Failure("settings.invalid_integer", $"配置“{configurationKey}”必须是整数。");
        if (UrlUserConfigurationKeys.Contains(configurationKey) && value.Length > 0 &&
            (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")))
            return OperationResult.Failure("settings.invalid_url", $"配置“{configurationKey}”必须是有效的 HTTP/HTTPS 地址。");
        if (configurationKey == "App:CharacterCardTemplate:RefreshIntervalHours" &&
            (!int.TryParse(value, out var refreshHours) || refreshHours is < 1 or > 720))
            return OperationResult.Failure("settings.invalid_template_interval", "角色模板刷新周期必须在 1 到 720 小时之间。");
        return null;
    }

    private static readonly HashSet<string> BooleanUserConfigurationKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "App:AgentEnabled", "DataSync:Enabled", "App:Tts:Enabled", "App:Tts:ShiftEnterStreamTtsEnabled", "App:Asr:Enabled",
        "App:Live2D:Enabled", "PotPlayerBridge:Enabled", "PotPlayerBridge:UseM3u8Bom",
        "PotPlayerBridge:EnableChunkAppend", "PotPlayerBridge:EnableTitleSync", "PotPlayerBridge:EnablePlaybackHighlight"
    };

    private static readonly HashSet<string> IntegerUserConfigurationKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "App:MaxToolSteps", "DataSync:UserId", "DataSync:BatchSize", "App:Tts:StartupTimeoutSeconds",
        "App:Tts:RequestTimeoutSeconds", "App:Tts:ParallelSynthesisCount", "App:Tts:StreamTtsStartBufferMs", "App:Asr:RequestTimeoutSeconds",
        "App:Tts:StreamTtsMaxStartWaitMs", "App:Tts:StreamTtsSampleRate", "App:Tts:StreamTtsChannels",
        "App:VoiceCache:DefaultIntimacyLevel", "App:VoiceCache:LazyCachePeriodHours",
        "App:CharacterCardTemplate:RefreshIntervalHours", "App:Live2D:ConnectTimeoutSeconds",
        "App:PngSequence:DefaultFps", "PotPlayerBridge:MaxPlaylistItems"
    };

    private static readonly HashSet<string> UrlUserConfigurationKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "DataSync:ServerUrl", "App:Tts:Endpoint", "App:Tts:StreamTtsUrl", "App:Asr:Endpoint"
    };

    internal static SettingDto? DefaultSetting(string key)
        => EffectiveDefaults.TryGetValue(key, out var value) ? new SettingDto(key, value, DateTimeOffset.MinValue) : null;

    private static readonly IReadOnlyDictionary<string, string> EffectiveDefaults = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["ui_language"] = "zh-CN", ["realtime_tts_enabled"] = "True", ["ai_proactive_enabled"] = "True",
        ["master_audio_muted"] = "False", ["master_audio_volume"] = "100",
        ["voice_cache_period_hours"] = "1", ["comic_bubble_style"] = "", ["music_visualizer_style"] = "surround-bars", ["disturbance_mode"] = "normal",
        ["user_config:App:AgentEnabled"] = "True", ["user_config:App:MaxToolSteps"] = "4",
        ["user_config:App:Proxy:Address"] = "127.0.0.1:6324", ["user_config:DataSync:Enabled"] = "True",
        ["user_config:DataSync:ServerUrl"] = "http://35.78.120.126", ["user_config:DataSync:UserId"] = "0",
        ["user_config:DataSync:DeviceId"] = "aimaid-main-pc", ["user_config:DataSync:BatchSize"] = "100",
        ["user_config:App:Tts:Enabled"] = "True", ["user_config:App:Tts:Endpoint"] = "http://127.0.0.1:8765",
        ["user_config:App:Tts:StartScriptPath"] = @"F:\AI\cosyvoice_tts_service\start_tts_service.bat",
        ["user_config:App:Tts:WorkingDirectory"] = @"F:\AI\cosyvoice_tts_service",
        ["user_config:App:Tts:StartupTimeoutSeconds"] = "60", ["user_config:App:Tts:RequestTimeoutSeconds"] = "90",
        ["user_config:App:Tts:ParallelSynthesisCount"] = "2", ["user_config:App:Tts:ShiftEnterStreamTtsEnabled"] = "True",
        ["user_config:App:Tts:StreamTtsUrl"] = "http://127.0.0.1:8765/v1/tts/stream",
        ["user_config:App:Tts:VoiceId"] = "", ["user_config:App:Tts:StreamTtsStartBufferMs"] = "800",
        ["user_config:App:Asr:Enabled"] = "True", ["user_config:App:Asr:Endpoint"] = "http://35.78.120.126",
        ["user_config:App:Asr:RequestTimeoutSeconds"] = "120",
        ["user_config:App:Tts:StreamTtsMaxStartWaitMs"] = "1500", ["user_config:App:Tts:StreamTtsSampleRate"] = "24000",
        ["user_config:App:Tts:StreamTtsChannels"] = "1", ["user_config:App:ImageTilesDirectory"] = "Assets/image_tiles",
        ["user_config:App:Tts:DailyCacheDirectory"] = @"Assets\voicesRoles\cache\daily_interaction",
        ["user_config:App:Tts:AiLatestCacheDirectory"] = @"Assets\voicesRoles\cache\ai_latest",
        ["user_config:App:VoiceCache:ManifestPath"] = @"Assets\voiceCache\cache_named_top10\cache_manifest_top10.csv",
        ["user_config:App:VoiceCache:DefaultIntimacyLevel"] = "5", ["user_config:App:VoiceCache:LazyCachePeriodHours"] = "1",
        ["user_config:App:CharacterCardTemplate:RefreshIntervalHours"] = "4",
        ["user_config:App:Live2D:Enabled"] = "True", ["user_config:App:Live2D:RendererExePath"] = @"C:\Users\49213\Desktop\A\codex\Live\release\MaidAI\Live2DRenderer\Live2DRenderer.exe",
        ["user_config:App:Live2D:ModelsDirectory"] = @"C:\Users\49213\Desktop\A\codex\Live\assests\live2d",
        ["user_config:App:Live2D:LogDirectory"] = @"C:\Users\49213\AppData\Local\AI_maid\logs",
        ["user_config:App:Live2D:ConnectTimeoutSeconds"] = "30", ["user_config:App:PngSequence:BaseDirectory"] = "Assets/pngLine",
        ["user_config:App:PngSequence:DefaultRole"] = "xinxin", ["user_config:App:PngSequence:DefaultFps"] = "30",
        ["user_config:PotPlayerBridge:Enabled"] = "True", ["user_config:PotPlayerBridge:PotPlayerExePath"] = @"F:\软件\pot\PotPlayer\PotPlayerMini64.exe",
        ["user_config:PotPlayerBridge:PlaylistDirectory"] = @"%LocalAppData%\AI_Maid\PotPlayerBridge",
        ["user_config:PotPlayerBridge:CurrentPlaylistFileName"] = "current.m3u8", ["user_config:PotPlayerBridge:MaxPlaylistItems"] = "1000",
        ["user_config:PotPlayerBridge:UseM3u8Bom"] = "True", ["user_config:PotPlayerBridge:EnableChunkAppend"] = "False",
        ["user_config:PotPlayerBridge:EnableTitleSync"] = "False", ["user_config:PotPlayerBridge:EnablePlaybackHighlight"] = "False"
    };
}
