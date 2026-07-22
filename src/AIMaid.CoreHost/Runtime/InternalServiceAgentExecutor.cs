using System.Text.Json;
using AIMaid.Contracts.Domains;
using AIMaid.Core;

namespace AIMaid.CoreHost.Runtime;

public sealed class InternalServiceAgentExecutor(
    ReminderApplicationService reminders,
    SettingsBackedSpeechClient speech,
    MusicApplicationService music) : IAgentCapabilityExecutor
{
    public string ExecutorType => "internal_service";

    public async Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        using var configDocument = JsonDocument.Parse(capability.ConfigJson);
        using var argsDocument = JsonDocument.Parse(argsJson);
        var operation = configDocument.RootElement.TryGetProperty("operation", out var value) ? value.GetString() : null;
        return operation switch
        {
            "restart_tts" => await RestartTtsAsync(cancellationToken),
            "create_reminder" => await CreateReminderAsync(argsDocument.RootElement, cancellationToken),
            "search_and_play_music" => await SearchAndPlayMusicAsync(argsDocument.RootElement, cancellationToken),
            _ => new AgentExecutionResult(null, string.Empty, $"未支持的内部服务操作：{operation}")
        };
    }

    private async Task<AgentExecutionResult> RestartTtsAsync(CancellationToken cancellationToken)
    {
        try
        {
            await speech.EnsureReadyAsync(cancellationToken);
            return new AgentExecutionResult(0, "TTS 服务已启动", string.Empty);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        { return new AgentExecutionResult(null, string.Empty, exception.Message); }
    }

    private async Task<AgentExecutionResult> CreateReminderAsync(JsonElement args, CancellationToken cancellationToken)
    {
        var timeText = args.TryGetProperty("timeText", out var time) ? time.GetString() ?? string.Empty : string.Empty;
        var content = args.TryGetProperty("content", out var text) ? text.GetString() ?? string.Empty : string.Empty;
        var repeat = args.TryGetProperty("repeat", out var repeatValue) ? repeatValue.GetString() ?? "none" : "none";
        if (!TryParseNaturalTime(timeText, out var dueAt) || string.IsNullOrWhiteSpace(content))
            return new AgentExecutionResult(null, string.Empty, "提醒时间或内容无效；时间请使用“30分钟后”等格式。");
        var result = await reminders.HandleAsync(new SaveReminderCommand(null, content, $"提醒：{content}", dueAt, repeat, true, true), cancellationToken);
        return result.Succeeded && result.Value is not null
            ? new AgentExecutionResult(0, $"已创建提醒：{content}，时间：{dueAt:yyyy-MM-dd HH:mm}", string.Empty)
            : new AgentExecutionResult(null, string.Empty, result.ErrorMessage ?? "提醒创建失败。");
    }

    private async Task<AgentExecutionResult> SearchAndPlayMusicAsync(JsonElement args, CancellationToken cancellationToken)
    {
        var songName = args.TryGetProperty("songName", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
        var result = await music.SearchAndPlayAsync(songName, cancellationToken);
        if (!result.Succeeded || result.Value is null)
            return new AgentExecutionResult(null, string.Empty, result.ErrorMessage ?? "播放失败");
        return new AgentExecutionResult(0, $"正在播放：{result.Value.Title} - {result.Value.Singer}", string.Empty);
    }

    private static bool TryParseNaturalTime(string value, out DateTimeOffset dueAt)
    {
        dueAt = DateTimeOffset.Now;
        var text = value.Trim().Replace(" ", string.Empty, StringComparison.Ordinal);
        foreach (var (suffix, add) in new (string Suffix, Func<int, DateTimeOffset> Add)[]
        {
            ("分钟后", amount => DateTimeOffset.Now.AddMinutes(amount)),
            ("小时后", amount => DateTimeOffset.Now.AddHours(amount)),
            ("天后", amount => DateTimeOffset.Now.AddDays(amount))
        })
        {
            if (!text.EndsWith(suffix, StringComparison.Ordinal) || !int.TryParse(text[..^suffix.Length], out var amount) || amount <= 0) continue;
            dueAt = add(amount);
            return true;
        }
        return false;
    }
}
