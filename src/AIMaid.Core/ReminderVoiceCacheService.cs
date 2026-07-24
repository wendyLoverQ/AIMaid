using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed record ReminderVoiceCacheResult(string Text, string VoiceStyle, string AudioPath, bool TtsAllowed);

public sealed class ReminderVoiceCacheService
{
    private const string CurrentRoleKey = "voice_current_role_id";
    private readonly IAiProviderClient aiProvider;
    private readonly ITtsClient tts;
    private readonly ISettingsStore settings;
    private readonly ICharacterStore characters;
    private readonly ApplicationPaths paths;
    private readonly Action<string, Exception?> log;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);

    public ReminderVoiceCacheService(
        IAiProviderClient aiProvider,
        ITtsClient tts,
        ISettingsStore settings,
        ICharacterStore characters,
        ApplicationPaths paths,
        Action<string, Exception?>? log = null)
    {
        this.aiProvider = aiProvider;
        this.tts = tts;
        this.settings = settings;
        this.characters = characters;
        this.paths = paths;
        this.log = log ?? ((_, _) => { });
    }

    public async Task PrepareAsync(ReminderDto reminder, CancellationToken cancellationToken = default)
    {
        if (!reminder.Enabled || !reminder.AllowTts) return;
        try
        {
            await EnsureAsync(reminder, cancellationToken);
        }
        catch (Exception exception)
        {
            log($"Reminder voice cache pre-generation failed: reminderId={reminder.ReminderId}", exception);
        }
    }

    public async Task<ReminderVoiceCacheResult> EnsureAsync(
        ReminderDto reminder,
        CancellationToken cancellationToken = default)
    {
        var gate = gates.GetOrAdd(reminder.ReminderId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var rawText = string.IsNullOrWhiteSpace(reminder.Message)
                ? reminder.Title
                : reminder.Message;
            if (string.IsNullOrWhiteSpace(rawText)) rawText = "该处理提醒事项了。";

            var roleId = (await settings.GetAsync(CurrentRoleKey, cancellationToken))?.Value?.Trim() ?? string.Empty;
            CharacterDto? character = string.IsNullOrWhiteSpace(roleId)
                ? null
                : await characters.GetAsync(roleId, cancellationToken);
            if (reminder.AllowTts && character is null)
                return new ReminderVoiceCacheResult("当前角色卡未生成，已跳过本次提醒语音。", "normal", string.Empty, false);
            var voiceId = character?.PreferredVoiceId?.Trim() ?? string.Empty;
            var due = reminder.NextDueAt ?? reminder.DueAt;
            var cacheDate = DateOnly.FromDateTime(due.LocalDateTime);
            CleanupExpired(cacheDate);
            var cacheDirectory = ResolveDirectory(reminder.ReminderId, voiceId, cacheDate);
            var linePath = Path.Combine(cacheDirectory, "line.txt");
            var audioPath = Directory.Exists(cacheDirectory)
                ? Directory.EnumerateFiles(cacheDirectory)
                    .FirstOrDefault(path => !Path.GetFileName(path).Equals("line.txt", StringComparison.OrdinalIgnoreCase))
                : null;
            if (File.Exists(linePath) && !string.IsNullOrWhiteSpace(audioPath) && File.Exists(audioPath))
            {
                return new ReminderVoiceCacheResult(
                    (await File.ReadAllTextAsync(linePath, Encoding.UTF8, cancellationToken)).Trim(),
                    string.Empty,
                    audioPath,
                    true);
            }

            var generated = await GenerateLineAsync(reminder, rawText, roleId, cancellationToken);
            if (!reminder.AllowTts || string.IsNullOrWhiteSpace(voiceId))
                return new ReminderVoiceCacheResult(generated.Text, generated.VoiceStyle, string.Empty, true);

            Directory.CreateDirectory(cacheDirectory);
            await File.WriteAllTextAsync(linePath, generated.Text, Encoding.UTF8, cancellationToken);
            var synthesized = await tts.SynthesizeAsync(
                generated.Text,
                voiceId,
                generated.VoiceStyle,
                cancellationToken);
            if (string.IsNullOrWhiteSpace(synthesized) || !File.Exists(synthesized))
                return new ReminderVoiceCacheResult(generated.Text, generated.VoiceStyle, string.Empty, true);
            var extension = Path.GetExtension(synthesized);
            var cachedAudioPath = Path.Combine(cacheDirectory, "audio" + (string.IsNullOrWhiteSpace(extension) ? ".wav" : extension));
            File.Copy(synthesized, cachedAudioPath, overwrite: true);
            return new ReminderVoiceCacheResult(generated.Text, generated.VoiceStyle, cachedAudioPath, true);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<(string Text, string VoiceStyle)> GenerateLineAsync(
        ReminderDto reminder,
        string rawText,
        string roleId,
        CancellationToken cancellationToken)
    {
        var values = new Dictionary<string, string>
        {
            ["reminderId"] = reminder.ReminderId,
            ["reminderTitle"] = reminder.Title,
            ["reminderContent"] = rawText,
            ["dueTime"] = (reminder.NextDueAt ?? reminder.DueAt).ToString("yyyy-MM-dd HH:mm:ss"),
            ["repeatRule"] = reminder.Repeat,
            ["urgency"] = "normal",
            ["userOriginalText"] = rawText
        };
        try
        {
            var raw = new StringBuilder();
            await foreach (var delta in aiProvider.StreamChatAsync(new AiChatRequest(
                               $"reminder_line_{reminder.ReminderId}_{Guid.NewGuid():N}",
                               rawText,
                               roleId,
                               string.Empty,
                               [],
                               SourceKey: "reminder_line_generation",
                               TemplateValues: values,
                               RequireJsonResponse: true,
                               StreamResponse: false), cancellationToken))
                raw.Append(delta);
            using var document = JsonDocument.Parse(raw.ToString().Trim());
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("message", out var message) ||
                message.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(message.GetString()))
                throw new InvalidDataException("reminder_line_generation 返回内容缺少非空 message。");
            var voiceStyle = root.TryGetProperty("voiceStyle", out var style) && style.ValueKind == JsonValueKind.String
                ? style.GetString()?.Trim() ?? "normal"
                : "normal";
            return (CleanLine(message.GetString()), voiceStyle);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            log($"Failed to generate reminder speech line: reminderId={reminder.ReminderId}", exception);
            return (rawText, "normal");
        }
    }

    private string ResolveDirectory(string reminderId, string voiceId, DateOnly cacheDate)
    {
        var key = $"{reminderId}|{voiceId}|{cacheDate:yyyy-MM-dd}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16].ToLowerInvariant();
        return paths.Cache(Path.Combine("tts", "reminders", cacheDate.ToString("yyyy-MM-dd"), hash));
    }

    private void CleanupExpired(DateOnly keepDate)
    {
        var root = paths.Cache(Path.Combine("tts", "reminders"));
        if (!Directory.Exists(root)) return;
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            if (!DateOnly.TryParseExact(Path.GetFileName(directory), "yyyy-MM-dd", out var date) || date >= keepDate) continue;
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (Exception exception)
            {
                log($"Failed to delete expired reminder voice cache: directory={directory}", exception);
            }
        }
    }

    private static string CleanLine(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var text = value.Trim().Replace("```", string.Empty, StringComparison.Ordinal).Trim();
        text = text.Trim('"', '\'', '\u201c', '\u201d', '\u2018', '\u2019');
        return text.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .FirstOrDefault(line => line.Length > 0) ?? string.Empty;
    }
}
