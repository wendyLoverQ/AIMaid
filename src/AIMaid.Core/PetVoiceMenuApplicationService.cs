using System.Globalization;
using System.Text.Json;
using AIMaid.Contracts.PetVoice;

namespace AIMaid.Core;

public sealed class PetVoiceMenuApplicationService(
    ICharacterStore characters,
    ISettingsStore settings,
    IDomainDocumentStore documents,
    ApplicationPaths paths)
{
    private const string CurrentRoleKey = "voice_current_role_id";
    private const string IntimacyKey = "voice_intimacy_level";
    private const string VoiceCacheDomain = "voice_role_audio_cache";
    private const int DefaultIntimacyLevel = 5;

    public async Task<PetVoiceMenuStateDto> GetAsync(CancellationToken cancellationToken = default)
    {
        var currentRoleId = (await settings.GetAsync(CurrentRoleKey, cancellationToken))?.Value?.Trim() ?? string.Empty;
        var character = currentRoleId.Length == 0 ? null : await characters.GetAsync(currentRoleId, cancellationToken);
        var availableLevels = await LoadAvailableLevelsAsync(currentRoleId, cancellationToken);
        var key = GetIntimacySettingKey(currentRoleId);
        var saved = (await settings.GetAsync(key, cancellationToken))?.Value;
        var level = int.TryParse(saved, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : DefaultIntimacyLevel;
        return new PetVoiceMenuStateDto(
            currentRoleId,
            character?.Name ?? "未选择",
            level,
            FormatIntimacy(level),
            availableLevels);
    }

    public async Task<PetVoiceMenuStateDto> CycleAsync(CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        var levels = state.AvailableLevels.Count == 0 ? [DefaultIntimacyLevel] : state.AvailableLevels;
        var currentIndex = Array.IndexOf(levels.ToArray(), state.IntimacyLevel);
        var next = levels[(currentIndex + 1 + levels.Count) % levels.Count];
        await settings.SetManyAsync(
            new Dictionary<string, string> { [GetIntimacySettingKey(state.RoleId)] = next.ToString(CultureInfo.InvariantCulture) },
            cancellationToken);
        return state with { IntimacyLevel = next, IntimacyLabel = FormatIntimacy(next) };
    }

    public async Task<PetVoiceCacheClearResultDto> ClearCurrentCacheAsync(CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        if (state.RoleId.Length == 0) return new PetVoiceCacheClearResultDto(string.Empty, state.IntimacyLevel, 0, 0);
        var cacheRoot = Path.GetFullPath(paths.Cache("tts"));
        var deletedEntries = 0;
        var deletedFiles = 0;
        foreach (var id in await documents.ListIdsAsync(VoiceCacheDomain, cancellationToken))
        {
            var json = await documents.GetAsync(VoiceCacheDomain, id, cancellationToken);
            if (json is null) continue;
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (!Matches(root, "RoleId", "roleId", state.RoleId) || ReadInt(root, "IntimacyLevel", "intimacyLevel") != state.IntimacyLevel) continue;
            var audioPath = ReadString(root, "AudioPath", "audioPath");
            if (audioPath.Length > 0 && IsUnderRoot(audioPath, cacheRoot) && File.Exists(audioPath))
            {
                File.Delete(audioPath);
                deletedFiles++;
            }
            await documents.DeleteAsync(VoiceCacheDomain, id, cancellationToken);
            deletedEntries++;
        }
        return new PetVoiceCacheClearResultDto(state.RoleId, state.IntimacyLevel, deletedEntries, deletedFiles);
    }

    private async Task<IReadOnlyList<int>> LoadAvailableLevelsAsync(string roleId, CancellationToken cancellationToken)
    {
        if (roleId.Length == 0) return [];
        var levels = new SortedSet<int>();
        foreach (var json in await documents.ListAsync(VoiceCacheDomain, cancellationToken))
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (!root.TryGetProperty("roleId", out var role) ||
                !string.Equals(role.GetString(), roleId, StringComparison.OrdinalIgnoreCase) ||
                !root.TryGetProperty("intimacyLevel", out var level) || !level.TryGetInt32(out var value) || value <= 0)
                continue;
            if (root.TryGetProperty("isEnabled", out var enabled) && enabled.ValueKind == JsonValueKind.False) continue;
            levels.Add(value);
        }
        return levels.ToArray();
    }

    private static string GetIntimacySettingKey(string roleId)
        => roleId.Length == 0 ? IntimacyKey : $"{IntimacyKey}:{roleId}";

    private static string FormatIntimacy(int level) => level switch
    {
        1 => "冷淡 1 级",
        2 => "疏离 2 级",
        3 => "普通 3 级",
        4 => "亲近 4 级",
        5 => "信赖 5 级",
        6 => "依恋 6 级",
        _ => $"{level} 级"
    };

    private static bool Matches(JsonElement root, string first, string second, string expected)
        => string.Equals(ReadString(root, first, second), expected, StringComparison.OrdinalIgnoreCase);

    private static string ReadString(JsonElement root, string first, string second)
        => root.TryGetProperty(first, out var value) || root.TryGetProperty(second, out value) ? value.GetString() ?? string.Empty : string.Empty;

    private static int ReadInt(JsonElement root, string first, string second)
        => (root.TryGetProperty(first, out var value) || root.TryGetProperty(second, out value)) && value.TryGetInt32(out var result) ? result : 0;

    private static bool IsUnderRoot(string path, string root)
    {
        if (!Path.IsPathFullyQualified(path)) return false;
        var fullPath = Path.GetFullPath(path);
        var prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }
}
