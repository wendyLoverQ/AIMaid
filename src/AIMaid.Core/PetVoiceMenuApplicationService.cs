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
    IAtomicStore atomic,
    IEventPublisher events,
    IAiProviderClient aiProvider,
    ITtsClient tts,
    TemplateCardApplicationService templateCards,
    ApplicationPaths paths) : IAsyncDisposable
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
    private readonly SemaphoreSlim generationGate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly ConcurrentDictionary<string, Task> backgroundGenerations = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, byte> startupPlayedRoles = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> activeForegroundGenerations = new(StringComparer.OrdinalIgnoreCase);
    private readonly object foregroundSync = new();
    private CancellationTokenSource? foregroundCancellation;
    private string foregroundOwner = "";
    private CancellationTokenSource? periodScheduleCancellation;
    private Task? periodSchedule;
    private static long nextDocumentId = DateTimeOffset.UtcNow.Ticks;

    private static readonly IReadOnlyList<PetVoiceTriggerPlan> Plans = PetVoiceTriggerCatalog.Plans;

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
        bool forceRefresh = false,
        CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        if (state.RoleId.Length == 0)
            return OperationResult<PetVoiceCacheEnsureResultDto>.Failure("pet_voice.role_missing", "尚未选择当前语音角色。");
        if (forceRefresh) CancelForegroundGeneration(state.RoleId, state.IntimacyLevel);
        return await EnsureAsync(state.RoleId, state.IntimacyLevel, includeNextPeriod, cancellationToken);
    }

    public async Task<OperationResult<PetVoiceCacheClearResultDto>> ClearCurrentCacheAsync(CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        if (state.RoleId.Length == 0)
            return OperationResult<PetVoiceCacheClearResultDto>.Failure("pet_voice.role_missing", "当前没有可清理的语音角色。");
        CancelForegroundGeneration(state.RoleId, state.IntimacyLevel);
        var cacheKey = await GetCurrentCacheKeyAsync(0, cancellationToken);
        var deleted = await DeleteCacheEntriesAsync(state.RoleId, state.IntimacyLevel, cacheKey, cancellationToken);
        var ensured = await EnsureAsync(state.RoleId, state.IntimacyLevel, includeNextPeriod: false, cancellationToken);
        if (!ensured.Succeeded)
            return OperationResult<PetVoiceCacheClearResultDto>.Failure(ensured.ErrorCode!, ensured.ErrorMessage!);
        var value = ensured.Value!;
        return OperationResult<PetVoiceCacheClearResultDto>.Success(new(
            state.RoleId, state.IntimacyLevel, deleted.Entries, deleted.Files, deleted.Generations,
            value.GeneratedEntries, value.Ready, value.GenerationId,
            $"已清理并重新生成 {state.RoleName} 的 {state.IntimacyLabel} 当前语音缓存。"));
    }

    public async Task<OperationResult<PetVoicePlaybackDto>> ResolvePlaybackAsync(
        PlayPetVoiceCommand command,
        CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        if (state.RoleId.Length == 0)
            return OperationResult<PetVoicePlaybackDto>.Failure("pet_voice.role_missing", "尚未选择当前语音角色。");
        if (command.TriggerId.Equals("startup.welcome", StringComparison.OrdinalIgnoreCase) && startupPlayedRoles.ContainsKey(state.RoleId))
            return OperationResult<PetVoicePlaybackDto>.Success(new(false, "", "", "startup.welcome", "startup", "default", "", "", "", "startup_already_played"));
        var bodyPart = NormalizeBodyPart(command.BodyPart);
        var triggerId = NormalizeTrigger(command.TriggerId, bodyPart);
        if (!PetVoiceTriggerCatalog.Contains(triggerId, bodyPart))
            return OperationResult<PetVoicePlaybackDto>.Success(new(false, "", "", triggerId, "", bodyPart, "", "", "", "no_voice_plan"));
        var cacheKey = await GetCurrentCacheKeyAsync(0, cancellationToken);
        var character = await characters.GetAsync(state.RoleId, cancellationToken);
        if (character is null)
            return OperationResult<PetVoicePlaybackDto>.Failure("pet_voice.role_missing", "当前语音角色不存在。");
        var contextHash = await ComputeContextHashAsync(character, state.IntimacyLevel, cacheKey, cancellationToken);
        var readyGeneration = await FindReadyGenerationAsync(state.RoleId, state.IntimacyLevel, cacheKey, contextHash, cancellationToken);
        if (readyGeneration is null)
        {
            var generationState = await FindGenerationStateAsync(state.RoleId, state.IntimacyLevel, cacheKey, cancellationToken);
            var reason = activeForegroundGenerations.ContainsKey(GenerationContextKey(state.RoleId, state.IntimacyLevel, cacheKey, contextHash)) ? "cache_generating" :
                generationState?.Equals("failed", StringComparison.OrdinalIgnoreCase) == true ? "cache_failed" :
                generationState is null ? "cache_missing" : "cache_stale";
            return OperationResult<PetVoicePlaybackDto>.Success(new(false, "", contextHash, triggerId, "", bodyPart, "", "", "",
                reason));
        }
        var entries = await LoadEntriesAsync(state.RoleId, state.IntimacyLevel, cacheKey, cancellationToken);
        var selected = entries
            .Where(item => item.IsEnabled && item.ContextHash.Equals(contextHash, StringComparison.OrdinalIgnoreCase) &&
                           item.GenerationId.Equals(readyGeneration.GenerationId, StringComparison.OrdinalIgnoreCase) &&
                           item.TriggerId.Equals(triggerId, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(item => item.BodyPart.Equals(bodyPart, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(item => item.UpdatedAt)
            .FirstOrDefault();
        if (selected is null)
            return OperationResult<PetVoicePlaybackDto>.Success(new(false, "", contextHash, triggerId, "", bodyPart, "", "", "", "cache_missing"));
        if (!File.Exists(selected.AudioPath))
            return OperationResult<PetVoicePlaybackDto>.Success(new(false, selected.GenerationId, contextHash, triggerId, selected.Category, bodyPart,
                selected.Text, selected.AudioPath, selected.VoiceId, "audio_missing"));
        return OperationResult<PetVoicePlaybackDto>.Success(new(
            true, selected.GenerationId, selected.ContextHash, triggerId, selected.Category, bodyPart,
            selected.Text, selected.AudioPath, selected.VoiceId, "cache_match"));
    }

    public async Task ReportPlaybackAsync(ReportPetVoicePlaybackCommand command, CancellationToken cancellationToken = default)
    {
        var state = await GetAsync(cancellationToken);
        var now = DateTimeOffset.Now;
        var log = new VoiceTriggerLogDocument(
            now, command.Source, command.TriggerId, state.RoleId, string.IsNullOrWhiteSpace(command.Category) ? "click" : command.Category, NormalizeBodyPart(command.BodyPart),
            command.Played, command.Reason, command.Text, command.AudioPath, command.GenerationId, command.ContextHash,
            command.HitAreaName, command.NormalizedX, command.NormalizedY);
        await documents.UpsertAsync(VoiceTriggerLogDomain, NextId("legacy_voice_trigger_"),
            JsonSerializer.Serialize(log, JsonOptions), now, cancellationToken);
        if (command.Played && command.Source.Equals("pet.startup", StringComparison.OrdinalIgnoreCase))
            startupPlayedRoles.TryAdd(state.RoleId, 0);
    }

    private async Task<OperationResult<PetVoiceCacheEnsureResultDto>> EnsureAsync(
        string roleId,
        int intimacyLevel,
        bool includeNextPeriod,
        CancellationToken cancellationToken)
    {
        CharacterDto? character = null;
        var currentKey = string.Empty;
        var contextHash = string.Empty;
        var generationId = Guid.NewGuid().ToString("N");
        var generationCancellation = AcquireForegroundGeneration(roleId, intimacyLevel);
        var generationToken = generationCancellation.Token;
        await generationGate.WaitAsync(generationToken);
        try
        {
            character = await characters.GetAsync(roleId, generationToken);
            if (character is null || !character.IsEnabled)
                return OperationResult<PetVoiceCacheEnsureResultDto>.Failure("pet_voice.role_invalid", "当前语音角色不存在或已停用。");
            if (string.IsNullOrWhiteSpace(character.TemplateCardJson))
            {
                var generatedCard = await templateCards.HandleAsync(new GenerateTemplateCardCommand(roleId, false), generationToken);
                if (!generatedCard.Succeeded)
                    return OperationResult<PetVoiceCacheEnsureResultDto>.Failure(
                        "pet_voice.template_not_ready", generatedCard.ErrorMessage ?? "当前角色卡生成失败，无法生成语音缓存。");
                character = generatedCard.Value!;
            }

            await PurgeExpiredAsync(generationToken);
            await CleanupOrphanedDerivedAudioAsync(generationToken);
            currentKey = await GetCurrentCacheKeyAsync(0, generationToken);
            contextHash = await ComputeContextHashAsync(character, intimacyLevel, currentKey, generationToken);
            var readyGeneration = await FindReadyGenerationAsync(roleId, intimacyLevel, currentKey, contextHash, generationToken);
            if (readyGeneration is not null)
            {
                var readyEntries = await LoadEntriesAsync(roleId, intimacyLevel, currentKey, generationToken);
                if (IsCompleteGeneration(readyEntries, readyGeneration.GenerationId, contextHash))
                {
                    if (includeNextPeriod)
                    {
                        var nextKey = await GetCurrentCacheKeyAsync(1, generationToken);
                        var backgroundKey = $"{character.RoleId}:{intimacyLevel}:{nextKey}";
                        _ = backgroundGenerations.GetOrAdd(backgroundKey, _ => GenerateNextPeriodAsync(character, intimacyLevel, nextKey, backgroundKey));
                    }
                    var currentPeriod = await GetCurrentPeriodAsync(generationToken);
                    SchedulePeriodBoundary(currentPeriod);
                    return OperationResult<PetVoiceCacheEnsureResultDto>.Success(new(
                        readyGeneration.GenerationId, roleId, intimacyLevel, currentKey, contextHash, Plans.Count, 0, true,
                        currentPeriod.StartAt, currentPeriod.EndAt, currentPeriod.NextCacheKey, false, "ready",
                        $"{character.Name} 的 {FormatIntimacy(intimacyLevel)} 语音缓存已准备好。"));
                }
            }
            activeForegroundGenerations[GenerationContextKey(roleId, intimacyLevel, currentKey, contextHash)] = generationId;
            await PublishStatusAsync(generationId, character, intimacyLevel, currentKey, contextHash, "pending", 0, true, "缓存生成已排队。", "", "", generationToken);
            await PublishStatusAsync(generationId, character, intimacyLevel, currentKey, contextHash, "generating_lines", 0, true, "正在生成缓存文案。", "", "", generationToken);
            var generated = await GenerateMissingAsync(character, intimacyLevel, currentKey, contextHash, generationId, true, generationToken);
            var entries = (await LoadEntriesAsync(roleId, intimacyLevel, currentKey, generationToken))
                .Where(entry => entry.ContextHash.Equals(contextHash, StringComparison.OrdinalIgnoreCase)).ToArray();
            var ready = CountCompleted(entries) == Plans.Count;
            if (!ready)
                return OperationResult<PetVoiceCacheEnsureResultDto>.Failure(
                    "pet_voice.cache_incomplete", $"{character.Name} 的 {FormatIntimacy(intimacyLevel)} 语音缓存未完整生成：{CountCompleted(entries)}/{Plans.Count}。");

            if (includeNextPeriod)
            {
                var nextKey = await GetCurrentCacheKeyAsync(1, generationToken);
                var backgroundKey = $"{character.RoleId}:{intimacyLevel}:{nextKey}";
                _ = backgroundGenerations.GetOrAdd(backgroundKey, _ => GenerateNextPeriodAsync(character, intimacyLevel, nextKey, backgroundKey));
            }
            await PublishStatusAsync(generationId, character, intimacyLevel, currentKey, contextHash, "ready", Plans.Count, true, "当前语音缓存已准备好。", "", "", generationToken);
            SchedulePeriodBoundary(await GetCurrentPeriodAsync(generationToken));
            return OperationResult<PetVoiceCacheEnsureResultDto>.Success(new(
                generationId, roleId, intimacyLevel, currentKey, contextHash, Plans.Count, generated, true,
                (await GetCurrentPeriodAsync(generationToken)).StartAt, (await GetCurrentPeriodAsync(generationToken)).EndAt,
                (await GetCurrentPeriodAsync(generationToken)).NextCacheKey, false, "ready",
                $"{character.Name} 的 {FormatIntimacy(intimacyLevel)} 语音缓存已准备好。"));
        }
        catch (OperationCanceledException)
        {
            if (character is not null && currentKey.Length > 0)
                await PublishStatusAsync(generationId, character, intimacyLevel, currentKey, contextHash, "cancelled", 0, true,
                    "语音缓存生成已取消。", "", "", CancellationToken.None);
            throw;
        }
        catch (Exception exception)
        {
            if (character is not null && currentKey.Length > 0)
            {
                await PersistFailureWhenNoPriorGenerationAsync(generationId, character, intimacyLevel, currentKey, contextHash,
                    exception.Message, CancellationToken.None);
                await PublishStatusAsync(generationId, character, intimacyLevel, currentKey, contextHash, "failed", 0, true,
                    exception.Message, "pet_voice.cache_generation_failed", exception.Message, CancellationToken.None);
            }
            return OperationResult<PetVoiceCacheEnsureResultDto>.Failure("pet_voice.cache_generation_failed", exception.Message);
        }
        finally
        {
            if (currentKey.Length > 0) activeForegroundGenerations.TryRemove(GenerationContextKey(roleId, intimacyLevel, currentKey, contextHash), out _);
            generationGate.Release();
            ReleaseForegroundGeneration(generationCancellation);
        }
    }

    private CancellationTokenSource AcquireForegroundGeneration(string roleId, int intimacyLevel)
    {
        var owner = $"{roleId}:{intimacyLevel}";
        lock (foregroundSync)
        {
            if (foregroundCancellation is not null && !foregroundCancellation.IsCancellationRequested &&
                foregroundOwner.Equals(owner, StringComparison.OrdinalIgnoreCase))
                return foregroundCancellation;
            foregroundCancellation?.Cancel();
            foregroundCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            foregroundOwner = owner;
            return foregroundCancellation;
        }
    }

    private void ReleaseForegroundGeneration(CancellationTokenSource cancellation)
    {
        lock (foregroundSync)
        {
            if (!ReferenceEquals(foregroundCancellation, cancellation)) return;
            foregroundCancellation = null;
            foregroundOwner = "";
            cancellation.Dispose();
        }
    }

    private void CancelForegroundGeneration(string roleId, int intimacyLevel)
    {
        var owner = $"{roleId}:{intimacyLevel}";
        lock (foregroundSync)
            if (foregroundOwner.Equals(owner, StringComparison.OrdinalIgnoreCase)) foregroundCancellation?.Cancel();
    }

    private async Task GenerateNextPeriodAsync(CharacterDto character, int intimacyLevel, string cacheKey, string backgroundKey)
    {
        try
        {
            await generationGate.WaitAsync(lifetime.Token);
            try { await GenerateMissingAsync(character, intimacyLevel, cacheKey,
                await ComputeContextHashAsync(character, intimacyLevel, cacheKey, lifetime.Token),
                Guid.NewGuid().ToString("N"), false, lifetime.Token); }
            finally { generationGate.Release(); }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception)
        {
            var now = DateTimeOffset.Now;
            var diagnostic = new VoiceCacheDedupeDocument(
                cacheKey, character.RoleId, "background.next_period", "desktop_pet",
                FormatIntimacy(intimacyLevel), "", "", "failed", exception.Message, 1,
                "pet.voice_cache.ensure", now);
            await documents.UpsertAsync(VoiceCacheDedupeDomain, NextId("legacy_voice_cache_dedupe_"),
                JsonSerializer.Serialize(diagnostic, JsonOptions), now, lifetime.Token);
        }
        finally { backgroundGenerations.TryRemove(backgroundKey, out _); }
    }

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        lock (foregroundSync) foregroundCancellation?.Cancel();
        periodScheduleCancellation?.Cancel();
        if (periodSchedule is not null)
        {
            try { await periodSchedule; }
            catch (OperationCanceledException) { }
        }
        try { await Task.WhenAll(backgroundGenerations.Values); }
        catch (OperationCanceledException) { }
        lifetime.Dispose();
        generationGate.Dispose();
    }

    private void SchedulePeriodBoundary(PetVoiceCachePeriod period)
    {
        periodScheduleCancellation?.Cancel();
        periodScheduleCancellation?.Dispose();
        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        periodScheduleCancellation = cancellation;
        periodSchedule = CoordinatePeriodBoundaryAsync(period, cancellation.Token);
    }

    private async Task CoordinatePeriodBoundaryAsync(PetVoiceCachePeriod period, CancellationToken cancellationToken)
    {
        var delay = period.EndAt - DateTimeOffset.Now;
        if (delay > TimeSpan.Zero) await Task.Delay(delay, cancellationToken);
        await EnsureCurrentCacheAsync(includeNextPeriod: true, forceRefresh: false, cancellationToken);
    }

    private ValueTask PublishStatusAsync(string generationId, CharacterDto character, int intimacyLevel, string cacheKey,
        string contextHash, string phase, int completed, bool foreground, string message, string errorCode, string errorMessage,
        CancellationToken cancellationToken)
        => events.PublishAsync(new PetVoiceCacheStatusEvent(EventIdentity.NewId(), DateTimeOffset.Now, generationId,
            character.RoleId, character.Name, intimacyLevel, FormatIntimacy(intimacyLevel), cacheKey, contextHash, phase,
            completed, Plans.Count, message, errorCode, errorMessage, foreground, DateTimeOffset.Now), cancellationToken);

    private async Task<int> GenerateMissingAsync(
        CharacterDto character,
        int intimacyLevel,
        string cacheKey,
        string contextHash,
        string generationId,
        bool isForeground,
        CancellationToken cancellationToken)
    {
        var existing = await LoadEntriesAsync(character.RoleId, intimacyLevel, cacheKey, cancellationToken);
        // A generation is an all-or-nothing snapshot.  It never fills holes in a prior snapshot.
        var missing = Plans.ToArray();
        var roleVoices = await LoadRoleVoicesAsync(character.RoleId, cancellationToken);
        if (roleVoices.Count == 0) throw new InvalidOperationException($"角色“{character.Name}”没有已启用的音色绑定。");

        var lines = await GenerateLinesAsync(character, intimacyLevel, cacheKey, missing, existing, cancellationToken);
        await PublishStatusAsync(generationId, character, intimacyLevel, cacheKey, contextHash, "synthesizing", 0, isForeground, "正在合成缓存音频。", "", "", cancellationToken);
        var syntheses = new List<(PetVoiceTriggerPlan Plan, GeneratedLine Line, string VoiceId, Task<string> AudioTask)>();
        var stagingDirectory = paths.Cache(Path.Combine("tts", "voice_lazy_cache", ".staging", generationId));
        var finalDirectory = paths.Cache(Path.Combine("tts", "voice_lazy_cache", cacheKey, SafeSegment(character.RoleId),
            $"level-{intimacyLevel}", generationId));
        Directory.CreateDirectory(stagingDirectory);
        using var parallel = new SemaphoreSlim(2, 2);
        try
        {
            foreach (var plan in missing)
            {
                if (!lines.TryGetValue(plan.Key, out var line) || string.IsNullOrWhiteSpace(line.Text))
                    throw new InvalidDataException($"缓存文案缺少触发项：{plan.Key}");
                var style = NormalizeStyle(string.IsNullOrWhiteSpace(line.VoiceStyle) ? ResolveStyle(plan) : line.VoiceStyle);
                var voiceId = ResolveVoiceId(roleVoices, style)
                    ?? throw new InvalidOperationException($"角色“{character.Name}”无法为 {plan.Key} 选择音色。");
                syntheses.Add((plan, line with { VoiceStyle = style }, voiceId,
                    SynthesizeAndArchiveAsync(line.Text, voiceId, style, stagingDirectory, parallel, cancellationToken)));
            }

            await Task.WhenAll(syntheses.Select(item => item.AudioTask));
            await PublishStatusAsync(generationId, character, intimacyLevel, cacheKey, contextHash, "staging", Plans.Count, isForeground, "正在校验暂存音频。", "", "", cancellationToken);
            Directory.CreateDirectory(Path.GetDirectoryName(finalDirectory)!);
            Directory.Move(stagingDirectory, finalDirectory);
            var now = DateTimeOffset.Now;
            var replacements = syntheses.Select(async item => new VoiceCacheDocument(
                "lazy", cacheKey, character.RoleId, character.Name, item.VoiceId, item.Line.VoiceStyle,
                intimacyLevel, $"level_{intimacyLevel}", FormatIntimacy(intimacyLevel), item.Plan.TriggerId,
                item.Plan.Category, item.Plan.BodyPart, "", item.Line.Text, Hash(item.Line.Text),
                Path.Combine(finalDirectory, Path.GetFileName(await item.AudioTask)), null, true, now, now, generationId, contextHash)).ToArray();
            var entries = await Task.WhenAll(replacements);
            if (entries.Length != Plans.Count || entries.Any(x => !File.Exists(x.AudioPath) || new FileInfo(x.AudioPath).Length == 0))
                throw new InvalidDataException("语音缓存批次未形成完整可读音频，拒绝提交。");

            var prior = await LoadCacheEntryRowsAsync(character.RoleId, intimacyLevel, cacheKey, cancellationToken);
            var priorGenerationIds = await LoadGenerationIdsAsync(character.RoleId, intimacyLevel, cacheKey, cancellationToken);
            var period = await GetPeriodForCacheKeyAsync(cacheKey, cancellationToken);
            var mutations = new List<AtomicMutation>();
            await PublishStatusAsync(generationId, character, intimacyLevel, cacheKey, contextHash, "committing", Plans.Count, isForeground, "正在提交完整缓存批次。", "", "", cancellationToken);
            mutations.AddRange(prior.Select(x => new AtomicMutation(AtomicMutationKind.DeleteDomain, VoiceCacheDomain, x.Id, IdempotentDelete: true)));
            mutations.AddRange(priorGenerationIds.Select(id => new AtomicMutation(AtomicMutationKind.DeleteDomain, "voice_cache_generation", id, IdempotentDelete: true)));
            mutations.AddRange(entries.Select(x => new AtomicMutation(AtomicMutationKind.UpsertDomain, VoiceCacheDomain,
                NextId("legacy_voice_cache_"), JsonSerializer.Serialize(x, JsonOptions), now)));
            mutations.Add(new AtomicMutation(AtomicMutationKind.UpsertDomain, "voice_cache_generation", generationId,
                JsonSerializer.Serialize(new VoiceCacheGenerationDocument(generationId, character.RoleId, intimacyLevel,
                    cacheKey, contextHash, PetVoiceTriggerCatalog.Version, "ready", Plans.Count, Plans.Count,
                    period.StartAt, period.EndAt, "", "", now, now), JsonOptions), now));
            await atomic.ApplyAsync(mutations, cancellationToken);
            foreach (var old in prior)
            {
                try { DeleteDerivedAudio(old.Document.AudioPath); }
                catch (IOException) { /* New ready generation remains authoritative; orphan cleanup retries later. */ }
                catch (UnauthorizedAccessException) { /* New ready generation remains authoritative; orphan cleanup retries later. */ }
            }
            return entries.Length;
        }
        catch
        {
            if (Directory.Exists(stagingDirectory)) Directory.Delete(stagingDirectory, recursive: true);
            if (Directory.Exists(finalDirectory)) Directory.Delete(finalDirectory, recursive: true);
            throw;
        }
    }

    private async Task<Dictionary<string, GeneratedLine>> GenerateLinesAsync(
        CharacterDto character,
        int intimacyLevel,
        string cacheKey,
        IReadOnlyList<PetVoiceTriggerPlan> missing,
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
            var generated = ParseLines(raw.ToString());
            ValidateGeneratedBatch(generated, remaining);
            foreach (var line in generated)
            {
                if (line.Text.Length is < 1 or > 300) continue;
                if (line.VoiceStyle.Trim().ToLowerInvariant() is not ("normal" or "soft" or "lively" or "close")) continue;
                var fingerprint = NormalizeFingerprint(line.Text);
                if (fingerprint.Length == 0 || forbidden.Concat(result.Values.Select(value => value.Text))
                        .Any(text => NormalizeFingerprint(text).Equals(fingerprint, StringComparison.OrdinalIgnoreCase) || IsHighlySimilar(text, line.Text))) continue;
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
        string stagingDirectory,
        SemaphoreSlim parallel,
        CancellationToken cancellationToken)
    {
        await parallel.WaitAsync(cancellationToken);
        try
        {
            var source = await tts.SynthesizeAsync(text, voiceId, style, cancellationToken);
            if (!Path.IsPathFullyQualified(source) || !File.Exists(source))
                throw new FileNotFoundException("TTS 合成完成后没有返回可读取的本地音频文件。", source);
            Directory.CreateDirectory(stagingDirectory);
            var extension = Path.GetExtension(source);
            if (string.IsNullOrWhiteSpace(extension)) extension = ".wav";
            if (extension.ToLowerInvariant() is not (".wav" or ".mp3" or ".ogg"))
                throw new InvalidDataException($"TTS 返回了不支持的音频扩展名：{extension}");
            var target = Path.Combine(stagingDirectory, $"{Guid.NewGuid():N}{extension}");
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

    private async Task<IReadOnlyList<(string Id, VoiceCacheDocument Document)>> LoadCacheEntryRowsAsync(
        string roleId, int intimacyLevel, string cacheKey, CancellationToken cancellationToken)
    {
        var rows = new List<(string, VoiceCacheDocument)>();
        foreach (var id in await documents.ListIdsAsync(VoiceCacheDomain, cancellationToken))
        {
            var json = await documents.GetAsync(VoiceCacheDomain, id, cancellationToken);
            var item = json is null ? null : JsonSerializer.Deserialize<VoiceCacheDocument>(json, JsonOptions);
            if (item is not null && item.RoleId.Equals(roleId, StringComparison.OrdinalIgnoreCase) &&
                item.IntimacyLevel == intimacyLevel && item.CacheKey.Equals(cacheKey, StringComparison.OrdinalIgnoreCase)) rows.Add((id, item));
        }
        return rows;
    }

    private async Task<IReadOnlyList<string>> LoadGenerationIdsAsync(string roleId, int intimacyLevel, string cacheKey, CancellationToken cancellationToken)
    {
        var result = new List<string>();
        foreach (var id in await documents.ListIdsAsync("voice_cache_generation", cancellationToken))
        {
            var json = await documents.GetAsync("voice_cache_generation", id, cancellationToken);
            var generation = json is null ? null : JsonSerializer.Deserialize<VoiceCacheGenerationDocument>(json, JsonOptions);
            if (generation is not null && generation.RoleId.Equals(roleId, StringComparison.OrdinalIgnoreCase) &&
                generation.IntimacyLevel == intimacyLevel && generation.CacheKey.Equals(cacheKey, StringComparison.OrdinalIgnoreCase)) result.Add(id);
        }
        return result;
    }

    private async Task<VoiceCacheGenerationDocument?> FindReadyGenerationAsync(string roleId, int intimacyLevel, string cacheKey,
        string contextHash, CancellationToken cancellationToken)
    {
        foreach (var json in await documents.ListAsync("voice_cache_generation", cancellationToken))
        {
            var generation = JsonSerializer.Deserialize<VoiceCacheGenerationDocument>(json, JsonOptions);
            if (generation is not null && generation.Status.Equals("ready", StringComparison.OrdinalIgnoreCase) &&
                generation.RoleId.Equals(roleId, StringComparison.OrdinalIgnoreCase) && generation.IntimacyLevel == intimacyLevel &&
                generation.CacheKey.Equals(cacheKey, StringComparison.OrdinalIgnoreCase) && generation.ContextHash.Equals(contextHash, StringComparison.OrdinalIgnoreCase)) return generation;
        }
        return null;
    }

    private async Task<string?> FindGenerationStateAsync(string roleId, int intimacyLevel, string cacheKey, CancellationToken cancellationToken)
    {
        foreach (var json in await documents.ListAsync("voice_cache_generation", cancellationToken))
        {
            var generation = JsonSerializer.Deserialize<VoiceCacheGenerationDocument>(json, JsonOptions);
            if (generation is not null && generation.RoleId.Equals(roleId, StringComparison.OrdinalIgnoreCase) &&
                generation.IntimacyLevel == intimacyLevel && generation.CacheKey.Equals(cacheKey, StringComparison.OrdinalIgnoreCase)) return generation.Status;
        }
        return null;
    }

    // The table has one manifest per role/level/period.  A failed first attempt is durable;
    // an existing Ready manifest is intentionally untouched so a failed replacement cannot erase it.
    private async Task PersistFailureWhenNoPriorGenerationAsync(string generationId, CharacterDto character, int intimacyLevel,
        string cacheKey, string contextHash, string errorMessage, CancellationToken cancellationToken)
    {
        if ((await LoadGenerationIdsAsync(character.RoleId, intimacyLevel, cacheKey, cancellationToken)).Count > 0) return;
        var now = DateTimeOffset.Now;
        var period = await GetPeriodForCacheKeyAsync(cacheKey, cancellationToken);
        var failed = new VoiceCacheGenerationDocument(generationId, character.RoleId, intimacyLevel, cacheKey, contextHash,
            PetVoiceTriggerCatalog.Version, "failed", Plans.Count, 0, period.StartAt, period.EndAt,
            "pet_voice.cache_generation_failed", errorMessage, now, now);
        await atomic.ApplyAsync([new AtomicMutation(AtomicMutationKind.UpsertDomain, "voice_cache_generation", generationId,
            JsonSerializer.Serialize(failed, JsonOptions), now)], cancellationToken);
    }

    private async Task<(int Entries, int Files, int Generations)> DeleteCacheEntriesAsync(
        string roleId, int intimacyLevel, string cacheKey, CancellationToken cancellationToken)
    {
        var files = 0;
        var entries = await LoadCacheEntryRowsAsync(roleId, intimacyLevel, cacheKey, cancellationToken);
        var generations = await LoadGenerationIdsAsync(roleId, intimacyLevel, cacheKey, cancellationToken);
        var mutations = entries.Select(x => new AtomicMutation(AtomicMutationKind.DeleteDomain, VoiceCacheDomain, x.Id, IdempotentDelete: true))
            .Concat(generations.Select(id => new AtomicMutation(AtomicMutationKind.DeleteDomain, "voice_cache_generation", id, IdempotentDelete: true))).ToArray();
        await atomic.ApplyAsync(mutations, cancellationToken);
        foreach (var entry in entries)
        {
            if (File.Exists(entry.Document.AudioPath)) { DeleteDerivedAudio(entry.Document.AudioPath); files++; }
        }
        return (entries.Count, files, generations.Count);
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

    private async Task CleanupOrphanedDerivedAudioAsync(CancellationToken cancellationToken)
    {
        var root = Path.GetFullPath(paths.Cache(Path.Combine("tts", "voice_lazy_cache")));
        if (!Directory.Exists(root)) return;
        var referenced = (await documents.ListAsync(VoiceCacheDomain, cancellationToken))
            .Select(json => JsonSerializer.Deserialize<VoiceCacheDocument>(json, JsonOptions))
            .Where(item => item is not null && IsUnderRoot(item.AudioPath, root))
            .Select(item => Path.GetFullPath(item!.AudioPath)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}.staging{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase)) continue;
            if (!referenced.Contains(Path.GetFullPath(file))) File.Delete(file);
        }
        foreach (var directory in Directory.EnumerateDirectories(root, "*", SearchOption.AllDirectories)
                     .OrderByDescending(value => value.Length))
            if (!directory.EndsWith(".staging", StringComparison.OrdinalIgnoreCase) && !Directory.EnumerateFileSystemEntries(directory).Any()) Directory.Delete(directory);
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
        var period = PetVoiceCachePeriodCalculator.Calculate(DateTimeOffset.Now, hours);
        return offsetPeriods == 0 ? period.CacheKey : period.NextCacheKey;
    }

    private async Task<PetVoiceCachePeriod> GetCurrentPeriodAsync(CancellationToken cancellationToken)
    {
        var value = (await settings.GetAsync(CachePeriodKey, cancellationToken))?.Value;
        if (!int.TryParse(value, out var hours)) int.TryParse((await settings.GetAsync(LegacyCachePeriodKey, cancellationToken))?.Value, out hours);
        return PetVoiceCachePeriodCalculator.Calculate(DateTimeOffset.Now, hours is 1 or 2 or 4 or 8 or 16 ? hours : 1);
    }

    private async Task<PetVoiceCachePeriod> GetPeriodForCacheKeyAsync(string cacheKey, CancellationToken cancellationToken)
    {
        var current = await GetCurrentPeriodAsync(cancellationToken);
        if (cacheKey.Equals(current.CacheKey, StringComparison.OrdinalIgnoreCase)) return current;
        if (cacheKey.Equals(current.NextCacheKey, StringComparison.OrdinalIgnoreCase))
            return new PetVoiceCachePeriod(current.NextCacheKey, current.NextStartAt, current.NextEndAt,
                current.NextEndAt.ToString("yyyyMMddHH", CultureInfo.InvariantCulture), current.NextEndAt, current.NextEndAt.Add(current.NextEndAt - current.NextStartAt));
        return current;
    }

    // Deliberately canonical and secret-free: this identity is the admission ticket for playback.
    private async Task<string> ComputeContextHashAsync(CharacterDto character, int intimacyLevel, string cacheKey, CancellationToken cancellationToken)
    {
        var voices = await LoadRoleVoicesAsync(character.RoleId, cancellationToken);
        var voiceAssets = (await documents.ListAsync("voice_asset", cancellationToken))
            .Select(json => JsonSerializer.Deserialize<VoiceAssetDto>(json, JsonOptions)).Where(x => x is not null)
            .Cast<VoiceAssetDto>().ToDictionary(x => x.VoiceId, StringComparer.OrdinalIgnoreCase);
        var prompt = await documents.GetAsync("llm_source_prompt", "lazy_voice_lines", cancellationToken) ?? "";
        var model = await documents.GetAsync(BusinessModelDomain, "lazy_voice_cache", cancellationToken) ?? "";
        var businessModel = string.IsNullOrWhiteSpace(model) ? null : JsonSerializer.Deserialize<LlmBusinessModelConfigDto>(model, JsonOptions);
        var modelConfiguration = businessModel is null || string.IsNullOrWhiteSpace(businessModel.ModelKey) ? "" :
            await documents.GetAsync("model_configuration", businessModel.ModelKey, cancellationToken) ?? "";
        var enabled = (await settings.GetAsync("user_config:App:Tts:Enabled", cancellationToken))?.Value ?? "";
        var endpoint = Environment.GetEnvironmentVariable("AIMAID_TTS_ENDPOINT") ??
            (await settings.GetAsync("user_config:App:Tts:Endpoint", cancellationToken))?.Value ?? "";
        var defaultVoice = (await settings.GetAsync("user_config:App:Tts:VoiceId", cancellationToken))?.Value ?? "";
        var canonical = string.Join("\n", new[]
        {
            "implementation=pet_voice_cache_generation_v2", $"catalog={PetVoiceTriggerCatalog.Version}",
            $"bodyPartRules={PetVoiceTriggerCatalog.BodyPartRecognitionVersion}", $"role={character.RoleId}",
            $"level={intimacyLevel}", $"cache={cacheKey}", $"card={character.TemplateCardJson}",
            $"cardSource={character.TemplateCardSourceHash}", $"cardSchema={character.CardSchemaVersion}",
            $"voices={string.Join("|", voices.OrderBy(x => x.Style).ThenBy(x => x.VoiceId).Select(x => $"{x.Style}:{x.VoiceId}:{x.IsDefault}:{x.UpdatedAt:O}"))}",
            $"voiceAssets={string.Join("|", voices.OrderBy(x => x.Style).ThenBy(x => x.VoiceId).Select(x => voiceAssets.TryGetValue(x.VoiceId, out var asset)
                ? $"{asset.VoiceId}:{HashFile(Path.Combine(asset.VoiceFolderPath, "meta.json"))}:{HashFile(Path.Combine(asset.VoiceFolderPath, "prompt.txt"))}:{HashFile(Path.Combine(asset.VoiceFolderPath, "prompt.wav"))}" : $"{x.VoiceId}:missing"))}",
            $"prompt={prompt}", $"model={model}", $"modelConfiguration={modelConfiguration}", $"tts={enabled}:{endpoint}:{defaultVoice}",
            $"plans={string.Join("|", Plans.Select(x => $"{x.Key}:{x.Category}:{x.SuggestedStyle}"))}"
        });
        return Hash(canonical);
    }

    private static IReadOnlyList<GeneratedLine> ParseLines(string raw)
    {
        var json = raw.Trim();
        if (!json.StartsWith('{') || !json.EndsWith('}')) throw new InvalidDataException("缓存文案模型必须只返回 JSON 对象。");
        using var document = JsonDocument.Parse(json);
        if (!document.RootElement.TryGetProperty("lines", out var lines) || lines.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("缓存文案模型返回结果缺少 lines 数组。");
        return lines.EnumerateArray().Select(item =>
        {
            var key = ReadString(item, "key");
            return new GeneratedLine(string.IsNullOrWhiteSpace(key) ? ReadString(item, "cacheKey") : key,
                ReadString(item, "text"), ReadString(item, "voiceStyle"));
        }).ToArray();
    }

    private static void ValidateGeneratedBatch(IReadOnlyList<GeneratedLine> lines, IReadOnlyList<PetVoiceTriggerPlan> requested)
    {
        if (lines.Count != requested.Count) throw new InvalidDataException($"缓存文案数量错误：期望 {requested.Count}，实际 {lines.Count}。");
        var requestedKeys = requested.Select(x => x.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var resultKeys = lines.Select(x => x.CacheKey).ToArray();
        if (resultKeys.Any(string.IsNullOrWhiteSpace) || resultKeys.Distinct(StringComparer.OrdinalIgnoreCase).Count() != resultKeys.Length ||
            resultKeys.Any(key => !requestedKeys.Contains(key))) throw new InvalidDataException("缓存文案包含重复或未请求的槽位。");
        if (lines.Any(x => string.IsNullOrWhiteSpace(x.Text) || x.Text.Trim().Length > 300)) throw new InvalidDataException("缓存文案存在空文本或超长文本。");
    }

    private static string? ResolveVoiceId(IReadOnlyList<RoleVoiceDto> voices, string style)
        => voices.FirstOrDefault(item => NormalizeStyle(item.Style).Equals(style, StringComparison.OrdinalIgnoreCase))?.VoiceId
           ?? voices.FirstOrDefault(item => item.IsDefault)?.VoiceId
           ?? voices.FirstOrDefault()?.VoiceId;

    private static string ResolveStyle(PetVoiceTriggerPlan plan) => plan.SuggestedStyle;

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
        if (trigger is "click" or "click.default" || trigger.Length == 0) return "click";
        return trigger;
    }

    private static bool SameSlot(VoiceCacheDocument item, PetVoiceTriggerPlan plan)
        => item.TriggerId.Equals(plan.TriggerId, StringComparison.OrdinalIgnoreCase) && item.BodyPart.Equals(plan.BodyPart, StringComparison.OrdinalIgnoreCase);

    private static int CountCompleted(IReadOnlyList<VoiceCacheDocument> entries)
        => Plans.Count(plan => entries.Any(item => SameSlot(item, plan) && item.IsEnabled && File.Exists(item.AudioPath)));

    private static bool IsCompleteGeneration(IReadOnlyList<VoiceCacheDocument> entries, string generationId, string contextHash)
        => entries.Count == Plans.Count && entries.All(item => item.IsEnabled &&
            item.GenerationId.Equals(generationId, StringComparison.OrdinalIgnoreCase) &&
            item.ContextHash.Equals(contextHash, StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrWhiteSpace(item.Text) && !string.IsNullOrWhiteSpace(item.VoiceId) &&
            File.Exists(item.AudioPath) && new FileInfo(item.AudioPath).Length > 0) &&
           Plans.All(plan => entries.Count(item => SameSlot(item, plan)) == 1);

    private static string GetIntimacySettingKey(string roleId)
        => roleId.Length == 0 ? IntimacyKey : $"{IntimacyKey}:{roleId}";

    private static string FormatIntimacy(int level) => level switch
    {
        1 => "冷淡 1 级", 2 => "疏离 2 级", 3 => "普通 3 级", 4 => "亲近 4 级", 5 => "信赖 5 级", 6 => "依恋 6 级", _ => $"{level} 级"
    };
    private static string GenerationContextKey(string roleId, int intimacyLevel, string cacheKey, string contextHash)
        => $"{roleId}:{intimacyLevel}:{cacheKey}:{contextHash}";

    private static string NextId(string prefix) => prefix + Interlocked.Increment(ref nextDocumentId).ToString(CultureInfo.InvariantCulture);
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static string HashFile(string path) => File.Exists(path) ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) : "missing";
    private static string NormalizeFingerprint(string value)
        => new(value.Where(ch => !char.IsWhiteSpace(ch) && !",.?!;:\"'“”’~…()[]{}<>《》，。！？、；：".Contains(ch)).ToArray());
    private static bool IsHighlySimilar(string left, string right)
    {
        var a = NormalizeFingerprint(left); var b = NormalizeFingerprint(right);
        if (a.Length < 2 || b.Length < 2) return a.Equals(b, StringComparison.OrdinalIgnoreCase);
        var aBigrams = Enumerable.Range(0, a.Length - 1).Select(i => a.Substring(i, 2)).ToHashSet(StringComparer.Ordinal);
        var bBigrams = Enumerable.Range(0, b.Length - 1).Select(i => b.Substring(i, 2)).ToHashSet(StringComparer.Ordinal);
        return aBigrams.Count > 0 && (double)aBigrams.Intersect(bBigrams).Count() / aBigrams.Union(bBigrams).Count() >= .82;
    }
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

    private void DeleteDerivedAudio(string path)
    {
        var root = Path.GetFullPath(paths.Cache("tts"));
        if (IsUnderRoot(path, root) && File.Exists(path)) File.Delete(path);
    }

    private sealed record GeneratedLine(string CacheKey, string Text, string VoiceStyle);
    private sealed record VoiceCacheDocument(
        string CacheKind, string CacheKey, string RoleId, string DisplayName, string VoiceId, string Style,
        int IntimacyLevel, string TierId, string TierName, string TriggerId, string Category, string BodyPart,
        string Emotion, string Text, string TextHash, string AudioPath, DateTimeOffset? ExpiresAt,
        bool IsEnabled, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string GenerationId = "", string ContextHash = "");
    private sealed record VoiceCacheGenerationDocument(
        string GenerationId, string RoleId, int IntimacyLevel, string CacheKey, string ContextHash, string CatalogVersion,
        string Status, int TotalEntries, int CompletedEntries, DateTimeOffset PeriodStartAt, DateTimeOffset PeriodEndAt,
        string ErrorCode, string ErrorMessage, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
    private sealed record VoiceTriggerLogDocument(
        DateTimeOffset CreatedAt, string Source, string TriggerId, string RoleId, string Category,
        string BodyPart, bool Played, string Reason, string Text, string AudioPath, string GenerationId,
        string ContextHash, string HitAreaName, double? NormalizedX, double? NormalizedY);
    private sealed record VoiceCacheDedupeDocument(
        string CacheKey, string RoleId, string TriggerType, string Scene, string Tier, string Text,
        string VoiceStyle, string DedupeStatus, string DuplicateReason, int AttemptIndex, string Source, DateTimeOffset CreatedAt);
}
