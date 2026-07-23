using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Domains;
using AIMaid.Contracts.PetVoice;

namespace AIMaid.Core;

public sealed class PetVoiceMenuApplicationService(
    ICharacterStore characters,
    ISettingsStore settings,
    IDomainDocumentStore documents,
    IAiProviderClient aiProvider,
    ITtsClient tts,
    TemplateCardApplicationService templateCards,
    ApplicationPaths paths)
{
    private const string CurrentRoleKey = "voice_current_role_id";
    private const string IntimacyKey = "voice_intimacy_level";
    private const string CachePeriodKey = "voice_cache_period_hours";
    private const string LegacyCachePeriodKey = "user_config:App:VoiceCache:LazyCachePeriodHours";
    private const string VoiceCacheDomain = "voice_role_audio_cache";
    private const string VoiceRoleVoiceDomain = "voice_role_voice";
    private const string VoiceTriggerLogDomain = "voice_trigger_log";
    private const string VoiceCacheDedupeDomain = "voice_cache_dedupe";
    private const string BusinessModelDomain = "llm_business_model";
    private const int DefaultIntimacyLevel = 5;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> GenerationGates = new(StringComparer.OrdinalIgnoreCase);
    private static long nextDocumentId = DateTimeOffset.UtcNow.Ticks;

    private static readonly IReadOnlyList<VoicePlan> Plans =
    [
        new("startup.welcome", "startup", "default"),
        new("click.head", "click", "head"),
        new("click.hair", "click", "hair"),
        new("click.face", "click", "face"),
        new("click.chest", "click", "chest"),
        new("click.body", "click", "body"),
        new("click.hand", "click", "hand"),
        new("click.leg", "click", "leg"),
        new("click.foot", "click", "foot"),
        new("long_press", "interaction", "long_press"),
        new("hover.long", "interaction", "hover"),
        new("event.praise", "event", "default")
    ];

    public async Task<PetVoiceMenuStateDto> GetAsync(CancellationToken cancellationToken = default)
    {
        var currentRoleId = (await settings.GetAsync(CurrentRoleKey, cancellationToken))?.Value?.Trim() ?? string.Empty;
        var character = currentRoleId.Length == 0 ? null : await characters.GetAsync(currentRoleId, cancellationToken);
        var availableLevels = await LoadAvailableLevelsAsync(currentRoleId, cancellationToken);
        var saved = (await settings.GetAsync(GetIntimacySettingKey(currentRoleId), cancellationToken))?.Value;
        var level = int.TryParse(saved, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : DefaultIntimacyLevel;
        return new PetVoiceMenuStateDto(currentRoleId, character?.Name ?? "未选择", level, FormatIntimacy(level), availableLevels);
    }

    public async Task<OperationResult<PetVoiceMenuStateDto>> CycleAsync(CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        if (state.RoleId.Length == 0)
            return OperationResult<PetVoiceMenuStateDto>.Failure("pet_voice.role_missing", "当前没有可切换好感度的语音角色。");
        var levels = state.AvailableLevels.Count == 0 ? Enumerable.Range(1, 6).ToArray() : state.AvailableLevels;
        var currentIndex = Array.IndexOf(levels.ToArray(), state.IntimacyLevel);
        var next = levels[(currentIndex + 1 + levels.Count) % levels.Count];
        await settings.SetManyAsync(
            new Dictionary<string, string> { [GetIntimacySettingKey(state.RoleId)] = next.ToString(CultureInfo.InvariantCulture) },
            cancellationToken);
        var generation = await EnsureAsync(state.RoleId, next, includeNextPeriod: true, cancellationToken);
        if (!generation.Succeeded)
            return OperationResult<PetVoiceMenuStateDto>.Failure(generation.ErrorCode!, generation.ErrorMessage!);
        return OperationResult<PetVoiceMenuStateDto>.Success(state with { IntimacyLevel = next, IntimacyLabel = FormatIntimacy(next) });
    }

    public async Task<OperationResult<PetVoiceCacheEnsureResultDto>> EnsureCurrentCacheAsync(
        bool includeNextPeriod = true,
        CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        if (state.RoleId.Length == 0)
            return OperationResult<PetVoiceCacheEnsureResultDto>.Failure("pet_voice.role_missing", "尚未选择当前语音角色。");
        return await EnsureAsync(state.RoleId, state.IntimacyLevel, includeNextPeriod, cancellationToken);
    }

    public async Task<OperationResult<PetVoiceCacheClearResultDto>> ClearCurrentCacheAsync(CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        if (state.RoleId.Length == 0)
            return OperationResult<PetVoiceCacheClearResultDto>.Failure("pet_voice.role_missing", "当前没有可清理的语音角色。");
        var cacheKey = await GetCurrentCacheKeyAsync(0, cancellationToken);
        var deleted = await DeleteCacheEntriesAsync(state.RoleId, state.IntimacyLevel, cacheKey, cancellationToken);
        var ensured = await EnsureAsync(state.RoleId, state.IntimacyLevel, includeNextPeriod: false, cancellationToken);
        if (!ensured.Succeeded)
            return OperationResult<PetVoiceCacheClearResultDto>.Failure(ensured.ErrorCode!, ensured.ErrorMessage!);
        var value = ensured.Value!;
        return OperationResult<PetVoiceCacheClearResultDto>.Success(new(
            state.RoleId, state.IntimacyLevel, deleted.Entries, deleted.Files,
            value.GeneratedEntries, value.Ready,
            $"已清理并重新生成 {state.RoleName} 的 {state.IntimacyLabel} 当前语音缓存。"));
    }

    public async Task<OperationResult<PetVoicePlaybackDto>> ResolvePlaybackAsync(
        PlayPetVoiceCommand command,
        CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        if (state.RoleId.Length == 0)
            return OperationResult<PetVoicePlaybackDto>.Failure("pet_voice.role_missing", "尚未选择当前语音角色。");
        var bodyPart = NormalizeBodyPart(command.BodyPart);
        var triggerId = NormalizeTrigger(command.TriggerId, bodyPart);
        var cacheKey = await GetCurrentCacheKeyAsync(0, cancellationToken);
        var entries = await LoadEntriesAsync(state.RoleId, state.IntimacyLevel, cacheKey, cancellationToken);
        var selected = entries
            .Where(item => item.IsEnabled && item.TriggerId.Equals(triggerId, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(item => item.BodyPart.Equals(bodyPart, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(item => item.UpdatedAt)
            .FirstOrDefault(item => File.Exists(item.AudioPath));
        if (selected is null)
            return OperationResult<PetVoicePlaybackDto>.Success(new(false, triggerId, bodyPart, "", "", "", "no_cache_match"));
        return OperationResult<PetVoicePlaybackDto>.Success(new(
            true, triggerId, bodyPart, selected.Text, selected.AudioPath, selected.VoiceId, "cache_match"));
    }

    public async Task ReportPlaybackAsync(ReportPetVoicePlaybackCommand command, CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        var now = DateTimeOffset.Now;
        var log = new VoiceTriggerLogDocument(
            now, command.Source, command.TriggerId, state.RoleId, "click", NormalizeBodyPart(command.BodyPart),
            command.Played, command.Reason, command.Text, command.AudioPath);
        await documents.UpsertAsync(VoiceTriggerLogDomain, NextId("legacy_voice_trigger_"),
            JsonSerializer.Serialize(log, JsonOptions), now, cancellationToken);
    }

    private async Task<OperationResult<PetVoiceCacheEnsureResultDto>> EnsureAsync(
        string roleId,
        int intimacyLevel,
        bool includeNextPeriod,
        CancellationToken cancellationToken)
    {
        var gate = GenerationGates.GetOrAdd(roleId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var character = await characters.GetAsync(roleId, cancellationToken);
            if (character is null || !character.IsEnabled)
                return OperationResult<PetVoiceCacheEnsureResultDto>.Failure("pet_voice.role_invalid", "当前语音角色不存在或已停用。");
            if (string.IsNullOrWhiteSpace(character.TemplateCardJson))
            {
                var generatedCard = await templateCards.HandleAsync(new GenerateTemplateCardCommand(roleId, false), cancellationToken);
                if (!generatedCard.Succeeded)
                    return OperationResult<PetVoiceCacheEnsureResultDto>.Failure(
                        "pet_voice.template_not_ready", generatedCard.ErrorMessage ?? "当前角色卡生成失败，无法生成语音缓存。");
                character = generatedCard.Value!;
            }

            await PurgeExpiredAsync(cancellationToken);
            var currentKey = await GetCurrentCacheKeyAsync(0, cancellationToken);
            var generated = await GenerateMissingAsync(character, intimacyLevel, currentKey, cancellationToken);
            var entries = await LoadEntriesAsync(roleId, intimacyLevel, currentKey, cancellationToken);
            var ready = CountCompleted(entries) == Plans.Count;
            if (!ready)
                return OperationResult<PetVoiceCacheEnsureResultDto>.Failure(
                    "pet_voice.cache_incomplete", $"{character.Name} 的 {FormatIntimacy(intimacyLevel)} 语音缓存未完整生成：{CountCompleted(entries)}/{Plans.Count}。");

            if (includeNextPeriod)
            {
                var nextKey = await GetCurrentCacheKeyAsync(1, cancellationToken);
                _ = GenerateNextPeriodAsync(character, intimacyLevel, nextKey);
            }
            return OperationResult<PetVoiceCacheEnsureResultDto>.Success(new(
                roleId, intimacyLevel, currentKey, Plans.Count, generated, true,
                $"{character.Name} 的 {FormatIntimacy(intimacyLevel)} 语音缓存已准备好。"));
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception exception)
        {
            return OperationResult<PetVoiceCacheEnsureResultDto>.Failure("pet_voice.cache_generation_failed", exception.Message);
        }
        finally { gate.Release(); }
    }

    private async Task GenerateNextPeriodAsync(CharacterDto character, int intimacyLevel, string cacheKey)
    {
        var gate = GenerationGates.GetOrAdd(character.RoleId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(CancellationToken.None);
        try { await GenerateMissingAsync(character, intimacyLevel, cacheKey, CancellationToken.None); }
        catch (Exception exception)
        {
            var now = DateTimeOffset.Now;
            var diagnostic = new VoiceCacheDedupeDocument(
                cacheKey, character.RoleId, "background.next_period", "desktop_pet",
                FormatIntimacy(intimacyLevel), "", "", "failed", exception.Message, 1,
                "pet.voice_cache.ensure", now);
            await documents.UpsertAsync(VoiceCacheDedupeDomain, NextId("legacy_voice_cache_dedupe_"),
                JsonSerializer.Serialize(diagnostic, JsonOptions), now, CancellationToken.None);
        }
        finally { gate.Release(); }
    }

    private async Task<int> GenerateMissingAsync(
        CharacterDto character,
        int intimacyLevel,
        string cacheKey,
        CancellationToken cancellationToken)
    {
        var existing = await LoadEntriesAsync(character.RoleId, intimacyLevel, cacheKey, cancellationToken);
        var missing = Plans.Where(plan => !existing.Any(item => SameSlot(item, plan) && File.Exists(item.AudioPath))).ToArray();
        if (missing.Length == 0) return 0;
        var roleVoices = await LoadRoleVoicesAsync(character.RoleId, cancellationToken);
        if (roleVoices.Count == 0) throw new InvalidOperationException($"角色“{character.Name}”没有已启用的音色绑定。");

        var lines = await GenerateLinesAsync(character, intimacyLevel, cacheKey, missing, existing, cancellationToken);
        var syntheses = new List<(VoicePlan Plan, GeneratedLine Line, string VoiceId, Task<string> AudioTask)>();
        using var parallel = new SemaphoreSlim(2, 2);
        foreach (var plan in missing)
        {
            if (!lines.TryGetValue(plan.Key, out var line) || string.IsNullOrWhiteSpace(line.Text))
                throw new InvalidDataException($"缓存文案缺少触发项：{plan.Key}");
            var style = NormalizeStyle(string.IsNullOrWhiteSpace(line.VoiceStyle) ? ResolveStyle(plan) : line.VoiceStyle);
            var voiceId = ResolveVoiceId(roleVoices, style)
                ?? throw new InvalidOperationException($"角色“{character.Name}”无法为 {plan.Key} 选择音色。");
            syntheses.Add((plan, line with { VoiceStyle = style }, voiceId,
                SynthesizeAndArchiveAsync(line.Text, voiceId, style, character.RoleId, cacheKey, parallel, cancellationToken)));
        }

        await Task.WhenAll(syntheses.Select(item => item.AudioTask));
        var now = DateTimeOffset.Now;
        foreach (var item in syntheses)
        {
            var audioPath = await item.AudioTask;
            var document = new VoiceCacheDocument(
                "lazy", cacheKey, character.RoleId, character.Name, item.VoiceId, item.Line.VoiceStyle,
                intimacyLevel, $"level_{intimacyLevel}", FormatIntimacy(intimacyLevel), item.Plan.TriggerId,
                item.Plan.Category, item.Plan.BodyPart, "", item.Line.Text, Hash(item.Line.Text), audioPath,
                null, true, now, now);
            await documents.UpsertAsync(VoiceCacheDomain, NextId("legacy_voice_cache_"),
                JsonSerializer.Serialize(document, JsonOptions), now, cancellationToken);
            var dedupe = new VoiceCacheDedupeDocument(
                cacheKey, character.RoleId, item.Plan.TriggerId, item.Plan.BodyPart, item.Plan.Category,
                item.Line.Text, item.Line.VoiceStyle, "accepted", "", 1, "lazy_voice_lines", now);
            await documents.UpsertAsync(VoiceCacheDedupeDomain, NextId("legacy_voice_cache_dedupe_"),
                JsonSerializer.Serialize(dedupe, JsonOptions), now, cancellationToken);
        }
        return syntheses.Count;
    }

    private async Task<Dictionary<string, GeneratedLine>> GenerateLinesAsync(
        CharacterDto character,
        int intimacyLevel,
        string cacheKey,
        IReadOnlyList<VoicePlan> missing,
        IReadOnlyList<VoiceCacheDocument> existing,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, GeneratedLine>(StringComparer.OrdinalIgnoreCase);
        var forbidden = existing.Select(item => item.Text).Where(text => !string.IsNullOrWhiteSpace(text)).ToList();
        for (var attempt = 1; attempt <= 3 && result.Count < missing.Count; attempt++)
        {
            var remaining = missing.Where(plan => !result.ContainsKey(plan.Key)).ToArray();
            var values = new Dictionary<string, string>
            {
                ["roleId"] = character.RoleId,
                ["roleName"] = character.Name,
                ["triggerType"] = "fixed_cache_batch",
                ["scene"] = "desktop_pet",
                ["tier"] = FormatIntimacy(intimacyLevel),
                ["count"] = remaining.Length.ToString(CultureInfo.InvariantCulture),
                ["style"] = "按触发项选择 normal/soft/lively/close",
                ["itemsJson"] = JsonSerializer.Serialize(remaining.Select(plan => new { key = plan.Key, triggerId = plan.TriggerId, category = plan.Category, bodyPart = plan.BodyPart })),
                ["existingLinesJson"] = JsonSerializer.Serialize(forbidden),
                ["acceptedLinesJson"] = JsonSerializer.Serialize(result.Values.Select(line => line.Text)),
                ["duplicateLinesJson"] = "[]",
                ["forbiddenSimilarLinesJson"] = JsonSerializer.Serialize(forbidden.Concat(result.Values.Select(line => line.Text))),
                ["attemptIndex"] = attempt.ToString(CultureInfo.InvariantCulture),
                ["maxAttempts"] = "3",
                ["retryReason"] = attempt == 1 ? "首次生成" : "补齐缺失或重复台词",
                ["replacementCount"] = remaining.Length.ToString(CultureInfo.InvariantCulture)
            };
            var raw = new StringBuilder();
            await foreach (var delta in aiProvider.StreamChatAsync(new AiChatRequest(
                               $"lazy_voice_{character.RoleId}_{cacheKey}_{Guid.NewGuid():N}",
                               "生成固定触发语音缓存台词", character.RoleId,
                               await LoadCacheModelAsync(cancellationToken), [],
                               SourceKey: "lazy_voice_lines", TemplateValues: values,
                               RequireJsonResponse: true, Temperature: 0.8, MaxTokens: 2048, StreamResponse: false), cancellationToken))
                raw.Append(delta);
            foreach (var line in ParseLines(raw.ToString()))
            {
                if (!remaining.Any(plan => plan.Key.Equals(line.CacheKey, StringComparison.OrdinalIgnoreCase))) continue;
                var fingerprint = NormalizeFingerprint(line.Text);
                if (fingerprint.Length == 0 || forbidden.Concat(result.Values.Select(value => value.Text))
                        .Any(text => NormalizeFingerprint(text).Equals(fingerprint, StringComparison.OrdinalIgnoreCase))) continue;
                result[line.CacheKey] = line;
            }
        }
        if (result.Count != missing.Count)
            throw new InvalidDataException($"缓存文案生成不完整：{result.Count}/{missing.Count}。");
        return result;
    }

    private async Task<string> SynthesizeAndArchiveAsync(
        string text,
        string voiceId,
        string style,
        string roleId,
        string cacheKey,
        SemaphoreSlim parallel,
        CancellationToken cancellationToken)
    {
        await parallel.WaitAsync(cancellationToken);
        try
        {
            var source = await tts.SynthesizeAsync(text, voiceId, style, cancellationToken);
            if (!Path.IsPathFullyQualified(source) || !File.Exists(source))
                throw new FileNotFoundException("TTS 合成完成后没有返回可读取的本地音频文件。", source);
            var directory = paths.Cache(Path.Combine("tts", "voice_lazy_cache", cacheKey, SafeSegment(roleId), SafeSegment(style)));
            Directory.CreateDirectory(directory);
            var extension = Path.GetExtension(source);
            if (string.IsNullOrWhiteSpace(extension)) extension = ".wav";
            var target = Path.Combine(directory, $"{Guid.NewGuid():N}{extension}");
            File.Copy(source, target, overwrite: false);
            return target;
        }
        finally { parallel.Release(); }
    }

    private async Task<IReadOnlyList<RoleVoiceDto>> LoadRoleVoicesAsync(string roleId, CancellationToken cancellationToken)
        => (await documents.ListAsync(VoiceRoleVoiceDomain, cancellationToken))
            .Select(json => JsonSerializer.Deserialize<RoleVoiceDto>(json, JsonOptions))
            .Where(item => item is not null && item.IsEnabled && item.RoleId.Equals(roleId, StringComparison.OrdinalIgnoreCase))
            .Cast<RoleVoiceDto>().ToArray();

    private async Task<IReadOnlyList<VoiceCacheDocument>> LoadEntriesAsync(
        string roleId, int intimacyLevel, string cacheKey, CancellationToken cancellationToken)
        => (await documents.ListAsync(VoiceCacheDomain, cancellationToken))
            .Select(json => JsonSerializer.Deserialize<VoiceCacheDocument>(json, JsonOptions))
            .Where(item => item is not null && item.RoleId.Equals(roleId, StringComparison.OrdinalIgnoreCase) &&
                           item.IntimacyLevel == intimacyLevel && item.CacheKey.Equals(cacheKey, StringComparison.OrdinalIgnoreCase))
            .Cast<VoiceCacheDocument>().ToArray();

    private async Task<(int Entries, int Files)> DeleteCacheEntriesAsync(
        string roleId, int intimacyLevel, string cacheKey, CancellationToken cancellationToken)
    {
        var entries = 0;
        var files = 0;
        var cacheRoot = Path.GetFullPath(paths.Cache("tts"));
        foreach (var id in await documents.ListIdsAsync(VoiceCacheDomain, cancellationToken))
        {
            var json = await documents.GetAsync(VoiceCacheDomain, id, cancellationToken);
            if (json is null) continue;
            var item = JsonSerializer.Deserialize<VoiceCacheDocument>(json, JsonOptions);
            if (item is null || !item.RoleId.Equals(roleId, StringComparison.OrdinalIgnoreCase) ||
                item.IntimacyLevel != intimacyLevel || !item.CacheKey.Equals(cacheKey, StringComparison.OrdinalIgnoreCase)) continue;
            if (IsUnderRoot(item.AudioPath, cacheRoot) && File.Exists(item.AudioPath)) { File.Delete(item.AudioPath); files++; }
            await documents.DeleteAsync(VoiceCacheDomain, id, cancellationToken);
            entries++;
        }
        return (entries, files);
    }

    private async Task PurgeExpiredAsync(CancellationToken cancellationToken)
    {
        var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            await GetCurrentCacheKeyAsync(0, cancellationToken),
            await GetCurrentCacheKeyAsync(1, cancellationToken)
        };
        var cacheRoot = Path.GetFullPath(paths.Cache("tts"));
        foreach (var id in await documents.ListIdsAsync(VoiceCacheDomain, cancellationToken))
        {
            var json = await documents.GetAsync(VoiceCacheDomain, id, cancellationToken);
            if (json is null) continue;
            var item = JsonSerializer.Deserialize<VoiceCacheDocument>(json, JsonOptions);
            if (item is null || !item.CacheKind.Equals("lazy", StringComparison.OrdinalIgnoreCase) || keep.Contains(item.CacheKey)) continue;
            if (IsUnderRoot(item.AudioPath, cacheRoot) && File.Exists(item.AudioPath)) File.Delete(item.AudioPath);
            await documents.DeleteAsync(VoiceCacheDomain, id, cancellationToken);
        }
    }

    private async Task<IReadOnlyList<int>> LoadAvailableLevelsAsync(string roleId, CancellationToken cancellationToken)
    {
        if (roleId.Length == 0) return [];
        var levels = new SortedSet<int>(Enumerable.Range(1, 6));
        foreach (var json in await documents.ListAsync(VoiceCacheDomain, cancellationToken))
        {
            var item = JsonSerializer.Deserialize<VoiceCacheDocument>(json, JsonOptions);
            if (item is not null && item.IsEnabled && item.RoleId.Equals(roleId, StringComparison.OrdinalIgnoreCase) && item.IntimacyLevel > 0)
                levels.Add(item.IntimacyLevel);
        }
        return levels.ToArray();
    }

    private async Task<string> LoadCacheModelAsync(CancellationToken cancellationToken)
    {
        var json = await documents.GetAsync(BusinessModelDomain, "lazy_voice_cache", cancellationToken);
        var value = json is null ? null : JsonSerializer.Deserialize<LlmBusinessModelConfigDto>(json, JsonOptions);
        if (value is null || !value.IsEnabled || string.IsNullOrWhiteSpace(value.ModelKey))
            throw new InvalidOperationException("缓存语音文案业务尚未选择模型。");
        return value.ModelKey;
    }

    private async Task<string> GetCurrentCacheKeyAsync(int offsetPeriods, CancellationToken cancellationToken)
    {
        var value = (await settings.GetAsync(CachePeriodKey, cancellationToken))?.Value;
        if (!int.TryParse(value, out var hours))
            int.TryParse((await settings.GetAsync(LegacyCachePeriodKey, cancellationToken))?.Value, out hours);
        if (hours is not (1 or 2 or 4 or 8 or 16)) hours = 1;
        var now = DateTime.Now;
        var epoch = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Local);
        var elapsedHours = (long)Math.Floor((now - epoch).TotalHours);
        var start = (elapsedHours / hours + offsetPeriods) * hours;
        return epoch.AddHours(start).ToString("yyyyMMddHH", CultureInfo.InvariantCulture);
    }

    private static IReadOnlyList<GeneratedLine> ParseLines(string raw)
    {
        var json = raw.Trim();
        var start = json.IndexOf('{');
        var end = json.LastIndexOf('}');
        if (start < 0 || end <= start) throw new InvalidDataException("缓存文案模型没有返回 JSON 对象。");
        using var document = JsonDocument.Parse(json[start..(end + 1)]);
        if (!document.RootElement.TryGetProperty("lines", out var lines) || lines.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("缓存文案模型返回结果缺少 lines 数组。");
        return lines.EnumerateArray().Select(item => new GeneratedLine(
            ReadString(item, "cacheKey"), ReadString(item, "text"), ReadString(item, "voiceStyle"))).ToArray();
    }

    private static string? ResolveVoiceId(IReadOnlyList<RoleVoiceDto> voices, string style)
        => voices.FirstOrDefault(item => NormalizeStyle(item.Style).Equals(style, StringComparison.OrdinalIgnoreCase))?.VoiceId
           ?? voices.FirstOrDefault(item => item.IsDefault)?.VoiceId
           ?? voices.FirstOrDefault()?.VoiceId;

    private static string ResolveStyle(VoicePlan plan)
        => plan.BodyPart is "head" or "hair" or "face" or "chest" ? "close"
            : plan.Category.Equals("interaction", StringComparison.OrdinalIgnoreCase) || plan.TriggerId.Contains("click", StringComparison.OrdinalIgnoreCase) ? "lively"
            : plan.Category is "startup" or "time" ? "soft" : "normal";

    private static string NormalizeStyle(string value)
        => value.Trim().ToLowerInvariant() is "soft" or "lively" or "close" ? value.Trim().ToLowerInvariant() : "normal";

    private static string NormalizeBodyPart(string value)
    {
        var normalized = value.Trim().ToLowerInvariant();
        return normalized switch
        {
            "hair" or "head" or "face" or "chest" or "body" or "hand" or "leg" or "foot" or "long_press" or "hover" => normalized,
            "bust" => "chest",
            "torso" or "waist" or "upper_body" or "lower_body" => "body",
            "arm" or "arms" => "hand",
            "other" => "body",
            _ => "body"
        };
    }

    private static string NormalizeTrigger(string triggerId, string bodyPart)
    {
        var trigger = triggerId.Trim().ToLowerInvariant();
        if (trigger is "click" or "click.default" || trigger.Length == 0) return $"click.{bodyPart}";
        return trigger;
    }

    private static bool SameSlot(VoiceCacheDocument item, VoicePlan plan)
        => item.TriggerId.Equals(plan.TriggerId, StringComparison.OrdinalIgnoreCase) && item.BodyPart.Equals(plan.BodyPart, StringComparison.OrdinalIgnoreCase);

    private static int CountCompleted(IReadOnlyList<VoiceCacheDocument> entries)
        => Plans.Count(plan => entries.Any(item => SameSlot(item, plan) && item.IsEnabled && File.Exists(item.AudioPath)));

    private static string GetIntimacySettingKey(string roleId)
        => roleId.Length == 0 ? IntimacyKey : $"{IntimacyKey}:{roleId}";

    private static string FormatIntimacy(int level) => level switch
    {
        1 => "冷淡 1 级", 2 => "疏离 2 级", 3 => "普通 3 级", 4 => "亲近 4 级", 5 => "信赖 5 级", 6 => "依恋 6 级", _ => $"{level} 级"
    };

    private static string NextId(string prefix) => prefix + Interlocked.Increment(ref nextDocumentId).ToString(CultureInfo.InvariantCulture);
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static string NormalizeFingerprint(string value)
        => new(value.Where(ch => !char.IsWhiteSpace(ch) && !",.?!;:\"'“”’~…()[]{}<>《》，。！？、；：".Contains(ch)).ToArray());
    private static string SafeSegment(string value)
        => string.Concat(value.Trim().Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch));
    private static string ReadString(JsonElement item, string name)
        => item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()?.Trim() ?? "" : "";
    private static bool IsUnderRoot(string path, string root)
    {
        if (!Path.IsPathFullyQualified(path)) return false;
        var prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return Path.GetFullPath(path).StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    private sealed record VoicePlan(string TriggerId, string Category, string BodyPart)
    {
        public string Key => BodyPart.Equals("default", StringComparison.OrdinalIgnoreCase) ? TriggerId : $"{TriggerId}|{BodyPart}";
    }
    private sealed record GeneratedLine(string CacheKey, string Text, string VoiceStyle);
    private sealed record VoiceCacheDocument(
        string CacheKind, string CacheKey, string RoleId, string DisplayName, string VoiceId, string Style,
        int IntimacyLevel, string TierId, string TierName, string TriggerId, string Category, string BodyPart,
        string Emotion, string Text, string TextHash, string AudioPath, DateTimeOffset? ExpiresAt,
        bool IsEnabled, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
    private sealed record VoiceTriggerLogDocument(
        DateTimeOffset CreatedAt, string Source, string TriggerId, string RoleId, string Category,
        string BodyPart, bool Played, string Reason, string Text, string AudioPath);
    private sealed record VoiceCacheDedupeDocument(
        string CacheKey, string RoleId, string TriggerType, string Scene, string Tier, string Text,
        string VoiceStyle, string DedupeStatus, string DuplicateReason, int AttemptIndex, string Source, DateTimeOffset CreatedAt);
}
