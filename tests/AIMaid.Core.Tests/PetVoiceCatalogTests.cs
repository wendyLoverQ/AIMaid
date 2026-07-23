using System.Text;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Domains;
using AIMaid.Contracts.Settings;
using AIMaid.Contracts.PetVoice;
using AIMaid.Core;
using AIMaid.Infrastructure;
using Microsoft.Data.Sqlite;

namespace AIMaid.Core.Tests;

[TestClass]
public sealed class PetVoiceCatalogTests
{
    [TestMethod]
    public void Catalog_HasExactlyNineReachableSlots()
    {
        Assert.AreEqual(9, PetVoiceTriggerCatalog.Plans.Count);
        Assert.IsTrue(PetVoiceTriggerCatalog.Contains("startup.welcome", "default"));
        Assert.IsTrue(PetVoiceTriggerCatalog.Contains("click", "face"));
        Assert.IsFalse(PetVoiceTriggerCatalog.Contains("hover.long", "default"));
    }

    [TestMethod]
    public void PeriodCalculator_ProducesContiguousCurrentAndNextPeriods()
    {
        var current = PetVoiceCachePeriodCalculator.Calculate(new DateTimeOffset(2026, 7, 23, 10, 35, 0, TimeSpan.FromHours(8)), 2);
        Assert.AreEqual(current.EndAt, current.NextStartAt);
        Assert.AreEqual(current.NextCacheKey, current.NextStartAt.ToString("yyyyMMddHH"));
        Assert.AreEqual(TimeSpan.FromHours(2), current.EndAt - current.StartAt);
    }

    [TestMethod]
    public async Task Ensure_ReadyGeneration_IsReusedWithoutAnotherLlmOrTtsBatch()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());

        var first = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        var second = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);

        Assert.IsTrue(first.Succeeded, first.ErrorMessage);
        Assert.IsTrue(second.Succeeded, second.ErrorMessage);
        Assert.IsTrue(first.Value!.Ready);
        Assert.AreEqual(9, first.Value.GeneratedEntries);
        Assert.AreEqual(0, second.Value!.GeneratedEntries);
        Assert.AreEqual(first.Value.GenerationId, second.Value.GenerationId);
        Assert.AreEqual(1, fixture.Ai.Calls);
        Assert.AreEqual(9, fixture.Tts.Calls);
        Assert.AreEqual(9, (await fixture.Documents.ListAsync("voice_role_audio_cache", CancellationToken.None)).Count);
        Assert.AreEqual(1, (await fixture.Documents.ListAsync("voice_cache_generation", CancellationToken.None)).Count);
    }

    [TestMethod]
    public async Task Ensure_ConcurrentSameIdentity_UsesOneGenerationBatch()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var fixture = new VoiceCacheFixture(CreateLinesJson(), new TestAi(CreateLinesJson(), started, blockFirstCall: true, firstCallRelease: release));
        var first = fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        release.TrySetResult();

        var values = await Task.WhenAll(first, second);

        Assert.IsTrue(values.All(value => value.Succeeded));
        Assert.AreEqual(1, fixture.Ai.Calls);
        Assert.AreEqual(9, fixture.Tts.Calls);
        Assert.AreEqual(values[0].Value!.GenerationId, values[1].Value!.GenerationId);
    }

    [TestMethod]
    public async Task Ensure_TemplateCardIdentityChange_RegeneratesInsteadOfReusingTheOldGeneration()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        var first = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        fixture.Characters.UpdateTemplate("{\"systemPrompt\":\"changed\"}");
        fixture.Ai.Response = CreateLinesJson("新身份台词");

        var second = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false, forceRefresh: true);

        Assert.IsTrue(first.Succeeded, first.ErrorMessage);
        Assert.IsTrue(second.Succeeded, second.ErrorMessage);
        Assert.AreNotEqual(first.Value!.GenerationId, second.Value!.GenerationId);
        Assert.AreNotEqual(first.Value.ContextHash, second.Value.ContextHash);
        Assert.AreEqual(2, fixture.Ai.Calls);
    }

    [TestMethod]
    public async Task Ensure_DefaultTtsVoiceChange_RegeneratesWithANewIdentity()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        var first = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        fixture.Ai.Response = CreateLinesJson("新音色身份台词");
        await fixture.Settings.SetManyAsync(new Dictionary<string, string> { ["user_config:App:Tts:VoiceId"] = "voice-b" });

        var second = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false, forceRefresh: true);

        Assert.IsTrue(first.Succeeded, first.ErrorMessage);
        Assert.IsTrue(second.Succeeded, second.ErrorMessage);
        Assert.AreNotEqual(first.Value!.ContextHash, second.Value!.ContextHash);
        Assert.AreNotEqual(first.Value.GenerationId, second.Value!.GenerationId);
    }

    [TestMethod]
    public async Task Ensure_SourcePromptChange_RegeneratesWithANewIdentity()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        var first = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        fixture.Ai.Response = CreateLinesJson("新提示词身份台词");
        fixture.Documents.Put("llm_source_prompt", "lazy_voice_lines", new LlmSourcePromptDto("lazy_voice_lines", "", "changed", "", "{}", true, DateTimeOffset.Now, DateTimeOffset.Now));

        var second = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false, forceRefresh: true);

        Assert.IsTrue(first.Succeeded, first.ErrorMessage);
        Assert.IsTrue(second.Succeeded, second.ErrorMessage);
        Assert.AreNotEqual(first.Value!.ContextHash, second.Value!.ContextHash);
        Assert.AreEqual(2, fixture.Ai.Calls);
    }

    [TestMethod]
    public async Task Ensure_ModelConfigurationChange_RegeneratesWithANewIdentity()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        var first = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        fixture.Ai.Response = CreateLinesJson("新模型身份台词");
        fixture.Documents.Put("model_configuration", "model-a", new ModelConfigurationDto("model-a", "openai", "https://changed.example.test", "new-model", "", false, false));

        var second = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false, forceRefresh: true);

        Assert.IsTrue(first.Succeeded, first.ErrorMessage);
        Assert.IsTrue(second.Succeeded, second.ErrorMessage);
        Assert.AreNotEqual(first.Value!.ContextHash, second.Value!.ContextHash);
        Assert.AreEqual(2, fixture.Ai.Calls);
    }

    [TestMethod]
    public async Task Ensure_IncompleteLines_LeavesNoReadyManifestOrPartialCache()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson(count: 8));

        var result = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);

        Assert.IsFalse(result.Succeeded);
        Assert.AreEqual("pet_voice.cache_generation_failed", result.ErrorCode);
        Assert.AreEqual(0, fixture.Tts.Calls);
        Assert.AreEqual(0, (await fixture.Documents.ListAsync("voice_role_audio_cache", CancellationToken.None)).Count);
        var manifests = await fixture.Documents.ListAsync("voice_cache_generation", CancellationToken.None);
        Assert.AreEqual(1, manifests.Count);
        using var manifest = JsonDocument.Parse(manifests[0]);
        Assert.AreEqual("failed", manifest.RootElement.GetProperty("status").GetString());
        var staging = fixture.Paths.Cache(Path.Combine("tts", "voice_lazy_cache", ".staging"));
        Assert.IsFalse(Directory.Exists(staging) && Directory.EnumerateFileSystemEntries(staging).Any());
    }

    [TestMethod]
    public async Task Ensure_RejectsLlmTextWrappedAroundTheRequiredJsonObject()
    {
        using var fixture = new VoiceCacheFixture("说明：" + CreateLinesJson());

        var result = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);

        Assert.IsFalse(result.Succeeded);
        Assert.AreEqual(0, fixture.Tts.Calls);
        var manifests = await fixture.Documents.ListAsync("voice_cache_generation", CancellationToken.None);
        Assert.AreEqual(1, manifests.Count);
        using var manifest = JsonDocument.Parse(manifests[0]);
        Assert.AreEqual("failed", manifest.RootElement.GetProperty("status").GetString());
    }

    [TestMethod]
    public async Task Ensure_UsesTemporarySqliteAndCommitsExactlyNineRecordsWithReadyManifest()
    {
        await using var fixture = await SqliteVoiceCacheFixture.CreateAsync(CreateLinesJson());

        var result = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);

        Assert.IsTrue(result.Succeeded, result.ErrorMessage);
        Assert.IsTrue(result.Value!.Ready);
        Assert.AreEqual(9, (await fixture.Documents.ListAsync("voice_role_audio_cache", CancellationToken.None)).Count);
        var manifests = await fixture.Documents.ListAsync("voice_cache_generation", CancellationToken.None);
        Assert.AreEqual(1, manifests.Count);
        using var manifest = JsonDocument.Parse(manifests[0]);
        Assert.AreEqual("ready", manifest.RootElement.GetProperty("Status").GetString());
        Assert.AreEqual(result.Value.GenerationId, manifest.RootElement.GetProperty("GenerationId").GetString());
    }

    [TestMethod]
    public async Task Cycle_CancelsThePreviousIntimacyGenerationBeforeStartingTheNewOne()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var fixture = new VoiceCacheFixture(CreateLinesJson(), new TestAi(CreateLinesJson(), started, blockFirstCall: true));
        var first = fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var cycled = await fixture.Service.CycleAsync();

        Assert.IsTrue(cycled.Succeeded, cycled.ErrorMessage);
        await Assert.ThrowsExactlyAsync<TaskCanceledException>(async () => await first);
        Assert.AreEqual(6, cycled.Value!.IntimacyLevel);
        Assert.AreEqual(9, (await fixture.Documents.ListAsync("voice_role_audio_cache", CancellationToken.None)).Count);
    }

    [TestMethod]
    public async Task Ensure_AtomicCommitFailure_PreservesThePreviousReadyGenerationAndRemovesNewFiles()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        var initial = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        Assert.IsTrue(initial.Succeeded, initial.ErrorMessage);
        fixture.Characters.UpdateTemplate("{\"systemPrompt\":\"changed\"}");
        fixture.Documents.FailAtomic = true;

        var failed = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);

        Assert.IsFalse(failed.Succeeded);
        var manifests = await fixture.Documents.ListAsync("voice_cache_generation", CancellationToken.None);
        Assert.AreEqual(1, manifests.Count);
        using var manifest = JsonDocument.Parse(manifests[0]);
        Assert.AreEqual(initial.Value!.GenerationId, manifest.RootElement.GetProperty("generationId").GetString());
        var cacheRoot = fixture.Paths.Cache(Path.Combine("tts", "voice_lazy_cache"));
        Assert.AreEqual(9, Directory.EnumerateFiles(cacheRoot, "*.*", SearchOption.AllDirectories)
            .Count(path => Path.GetExtension(path).Equals(".wav", StringComparison.OrdinalIgnoreCase)));
        var staging = fixture.Paths.Cache(Path.Combine("tts", "voice_lazy_cache", ".staging"));
        Assert.IsFalse(Directory.Exists(staging) && Directory.EnumerateFileSystemEntries(staging).Any());
    }

    [TestMethod]
    public async Task Ensure_ForceRefresh_CancelsTheActiveGenerationForTheSameRoleAndLevel()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var fixture = new VoiceCacheFixture(CreateLinesJson(), new TestAi(CreateLinesJson(), started, blockFirstCall: true));
        var first = fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var refreshed = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false, forceRefresh: true);

        Assert.IsTrue(refreshed.Succeeded, refreshed.ErrorMessage);
        await Assert.ThrowsExactlyAsync<TaskCanceledException>(async () => await first);
        Assert.AreEqual(9, (await fixture.Documents.ListAsync("voice_role_audio_cache", CancellationToken.None)).Count);
    }

    [TestMethod]
    public async Task DeleteCharacter_RemovesThatRolesDerivedVoiceCacheFilesAndRecords()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        var audioPath = fixture.Paths.Cache(Path.Combine("tts", "voice_lazy_cache", "period", "role-a", "voice.wav"));
        Directory.CreateDirectory(Path.GetDirectoryName(audioPath)!);
        await File.WriteAllBytesAsync(audioPath, [1, 2, 3]);
        fixture.Documents.Put("voice_role_audio_cache", "cache-1", new { RoleId = "role-a", AudioPath = audioPath });
        fixture.Documents.Put("voice_cache_generation", "generation-1", new { RoleId = "role-a" });
        var service = new CharacterApplicationService(fixture.Characters, fixture.Settings, fixture.Documents, new TestChatStore(), new InProcessEventPublisher(), fixture.Paths);

        var result = await service.HandleAsync(new DeleteCharacterCommand("role-a"));

        Assert.IsTrue(result.Succeeded, result.ErrorMessage);
        Assert.IsFalse(File.Exists(audioPath));
        Assert.AreEqual(0, (await fixture.Documents.ListAsync("voice_role_audio_cache", CancellationToken.None)).Count);
        Assert.AreEqual(0, (await fixture.Documents.ListAsync("voice_cache_generation", CancellationToken.None)).Count);
        Assert.IsNull(await fixture.Characters.GetAsync("role-a"));
    }

    [TestMethod]
    public async Task ResolvePlayback_MissingReadyAudioReportsAudioMissing()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        var ensured = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        Assert.IsTrue(ensured.Succeeded, ensured.ErrorMessage);
        var cache = (await fixture.Documents.ListAsync("voice_role_audio_cache", CancellationToken.None))
            .First(json => JsonDocument.Parse(json).RootElement.GetProperty("bodyPart").GetString() == "head");
        using (var document = JsonDocument.Parse(cache)) File.Delete(document.RootElement.GetProperty("audioPath").GetString()!);

        var playback = await fixture.Service.ResolvePlaybackAsync(new PlayPetVoiceCommand("click", "head"));

        Assert.IsTrue(playback.Succeeded, playback.ErrorMessage);
        Assert.IsFalse(playback.Value!.Matched);
        Assert.AreEqual("audio_missing", playback.Value.Reason);
    }

    [TestMethod]
    public async Task ResolvePlayback_ClickHeadReadsTheMatchingReadyCacheSlot()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        var ensured = await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);

        var playback = await fixture.Service.ResolvePlaybackAsync(new PlayPetVoiceCommand("click", "head"));

        Assert.IsTrue(ensured.Succeeded, ensured.ErrorMessage);
        Assert.IsTrue(playback.Succeeded, playback.ErrorMessage);
        Assert.IsTrue(playback.Value!.Matched);
        Assert.AreEqual("cache_match", playback.Value.Reason);
        Assert.AreEqual("click", playback.Value.TriggerId);
        Assert.AreEqual("head", playback.Value.BodyPart);
        Assert.AreEqual(ensured.Value!.GenerationId, playback.Value.GenerationId);
    }

    [TestMethod]
    public async Task StartupVoice_IsMarkedPlayedOnlyAfterASuccessfulPlaybackReport()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        var first = await fixture.Service.ResolvePlaybackAsync(new PlayPetVoiceCommand("startup.welcome", "default", "pet.startup"));
        Assert.IsTrue(first.Value!.Matched);
        await fixture.Service.ReportPlaybackAsync(new ReportPetVoicePlaybackCommand("startup.welcome", "default", first.Value.Text,
            first.Value.AudioPath, true, "cache_match", "pet.startup", first.Value.GenerationId, first.Value.ContextHash, first.Value.Category));

        var second = await fixture.Service.ResolvePlaybackAsync(new PlayPetVoiceCommand("startup.welcome", "default", "pet.startup"));

        Assert.IsTrue(second.Succeeded, second.ErrorMessage);
        Assert.IsFalse(second.Value!.Matched);
        Assert.AreEqual("startup_already_played", second.Value.Reason);
    }

    [TestMethod]
    public async Task StartupVoice_FailedPlaybackReportDoesNotConsumeTheSessionPlayback()
    {
        using var fixture = new VoiceCacheFixture(CreateLinesJson());
        await fixture.Service.EnsureCurrentCacheAsync(includeNextPeriod: false);
        var first = await fixture.Service.ResolvePlaybackAsync(new PlayPetVoiceCommand("startup.welcome", "default", "pet.startup"));
        await fixture.Service.ReportPlaybackAsync(new ReportPetVoicePlaybackCommand("startup.welcome", "default", first.Value!.Text,
            first.Value.AudioPath, false, "play_failed", "pet.startup", first.Value.GenerationId, first.Value.ContextHash, first.Value.Category));

        var retry = await fixture.Service.ResolvePlaybackAsync(new PlayPetVoiceCommand("startup.welcome", "default", "pet.startup"));

        Assert.IsTrue(retry.Value!.Matched);
        Assert.AreEqual("cache_match", retry.Value.Reason);
    }

    private static string CreateLinesJson(string prefix = "语音缓存测试台词", int count = 9)
    {
        var lines = PetVoiceTriggerCatalog.Plans.Take(count).Select((plan, index) =>
        {
            var text = plan.TriggerId == "startup.welcome"
                ? $"{prefix}，欢迎回来 {index + 1}"
                : $"{prefix} {index + 1}";
            if (text.Length < 8) text = text.PadRight(8, '呀');
            return new
            {
                key = plan.Key,
                text,
                voiceStyle = plan.SuggestedStyle
            };
        });
        return JsonSerializer.Serialize(new { lines });
    }

    private sealed class VoiceCacheFixture : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "AIMaidVoiceCacheTests", Guid.NewGuid().ToString("N"));
        public TestDocuments Documents { get; } = new();
        public TestCharacters Characters { get; }
        public TestSettings Settings { get; }
        public TestAi Ai { get; }
        public TestTts Tts { get; }
        public ApplicationPaths Paths { get; }
        public PetVoiceMenuApplicationService Service { get; }

        public VoiceCacheFixture(string linesJson, TestAi? ai = null)
        {
            Directory.CreateDirectory(root);
            Paths = ApplicationPaths.Create(root, root, root, root, root);
            var now = DateTimeOffset.Now;
            var character = new CharacterDto("role-a", "测试角色", "", "", "", "{\"name\":\"测试角色\"}", "{\"systemPrompt\":\"测试\"}",
                "voice-a", "valid", true, now, CardSchemaVersion: "v1", TemplateCardSourceHash: "source-a");
            Characters = new TestCharacters(character);
            Documents.Put("voice_role_voice", "voice-a", new RoleVoiceDto("role-a", "voice-a", "normal", true, true, now));
            Documents.Put("llm_business_model", "lazy_voice_cache", new LlmBusinessModelConfigDto("lazy_voice_cache", "缓存", "", "", "model-a", true, now, now));
            Documents.Put("llm_source_prompt", "lazy_voice_lines", new LlmSourcePromptDto("lazy_voice_lines", "", "", "", "{}", true, now, now));
            Documents.Put("model_configuration", "model-a", new ModelConfigurationDto("model-a", "openai", "https://example.test", "test", "", false, false));
            Settings = new TestSettings(new Dictionary<string, string>
            {
                ["voice_current_role_id"] = "role-a", ["voice_cache_period_hours"] = "1",
                ["user_config:App:Tts:Enabled"] = "true", ["user_config:App:Tts:VoiceId"] = "voice-a"
            });
            Ai = ai ?? new TestAi(linesJson);
            Tts = new TestTts(root);
            var events = new InProcessEventPublisher();
            var templateCards = new TemplateCardApplicationService(Characters, Documents, Ai, events);
            Service = new PetVoiceMenuApplicationService(Characters, Settings, Documents, Documents, events, Ai, Tts, templateCards, Paths);
        }

        public void Dispose()
        {
            Service.DisposeAsync().AsTask().GetAwaiter().GetResult();
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private sealed class TestAi(string response, TaskCompletionSource? firstCallStarted = null, bool blockFirstCall = false, TaskCompletionSource? firstCallRelease = null) : IAiProviderClient
    {
        private int calls;
        public string Response { get; set; } = response;
        public int Calls => Volatile.Read(ref calls);
        public async IAsyncEnumerable<string> StreamChatAsync(AiChatRequest request, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            var call = Interlocked.Increment(ref calls);
            if (call == 1) firstCallStarted?.TrySetResult();
            cancellationToken.ThrowIfCancellationRequested();
            if (call == 1 && blockFirstCall)
            {
                if (firstCallRelease is not null) await firstCallRelease.Task.WaitAsync(cancellationToken);
                else await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            yield return Response;
            await Task.CompletedTask;
        }
    }

    private sealed class TestTts(string root) : ITtsClient
    {
        public int Calls { get; private set; }
        public Task<string> SynthesizeAsync(string text, string? voiceId, string style, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            var path = Path.Combine(root, $"tts-{Calls}.wav");
            WriteValidWav(path);
            return Task.FromResult(path);
        }

        private static void WriteValidWav(string path)
        {
            const int sampleRate = 24_000;
            const short channels = 1;
            const short bits = 16;
            var data = new byte[sampleRate / 2 * channels * (bits / 8)];
            using var stream = File.Create(path);
            using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: false);
            writer.Write(Encoding.ASCII.GetBytes("RIFF"));
            writer.Write(36 + data.Length);
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
            writer.Write(16);
            writer.Write((short)1);
            writer.Write(channels);
            writer.Write(sampleRate);
            writer.Write(sampleRate * channels * (bits / 8));
            writer.Write((short)(channels * (bits / 8)));
            writer.Write(bits);
            writer.Write(Encoding.ASCII.GetBytes("data"));
            writer.Write(data.Length);
            writer.Write(data);
        }
    }

    private sealed class TestCharacters(CharacterDto character) : ICharacterStore
    {
        private CharacterDto value = character;
        public Task<CharacterDto?> GetAsync(string roleId, CancellationToken cancellationToken = default) => Task.FromResult<CharacterDto?>(value.RoleId == roleId ? value : null);
        public Task<IReadOnlyList<CharacterDto>> ListAsync(bool enabledOnly, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CharacterDto>>([value]);
        public Task UpsertAsync(CharacterDto character, CancellationToken cancellationToken = default) { value = character; return Task.CompletedTask; }
        public Task DeleteAsync(string roleId, CancellationToken cancellationToken = default) { value = value with { RoleId = "" }; return Task.CompletedTask; }
        public void UpdateTemplate(string templateCardJson) => value = value with { TemplateCardJson = templateCardJson, UpdatedAt = DateTimeOffset.Now };
    }

    private sealed class TestSettings(IReadOnlyDictionary<string, string> initial) : ISettingsStore
    {
        private readonly Dictionary<string, string> values = new(initial, StringComparer.OrdinalIgnoreCase);
        public Task<SettingDto?> GetAsync(string key, CancellationToken cancellationToken = default) => Task.FromResult(values.TryGetValue(key, out var value) ? new SettingDto(key, value, DateTimeOffset.Now) : null);
        public Task<IReadOnlyList<SettingDto>> GetManyAsync(IReadOnlyList<string>? keys, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<SettingDto>>(values.Select(pair => new SettingDto(pair.Key, pair.Value, DateTimeOffset.Now)).ToArray());
        public Task SetManyAsync(IReadOnlyDictionary<string, string> updates, CancellationToken cancellationToken = default) { foreach (var pair in updates) values[pair.Key] = pair.Value; return Task.CompletedTask; }
    }

    private sealed class TestDocuments : IDomainDocumentStore, IAtomicStore
    {
        private readonly Dictionary<string, Dictionary<string, string>> values = new(StringComparer.OrdinalIgnoreCase);
        public bool FailAtomic { get; set; }
        public void Put<T>(string domain, string id, T value) => GetDomain(domain)[id] = JsonSerializer.Serialize(value);
        public Task<string?> GetAsync(string domain, string id, CancellationToken cancellationToken = default) => Task.FromResult(GetDomain(domain).TryGetValue(id, out var value) ? value : null);
        public Task<IReadOnlyList<string>> ListAsync(string domain, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<string>>(GetDomain(domain).Values.ToArray());
        public Task<IReadOnlyList<string>> ListIdsAsync(string domain, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<string>>(GetDomain(domain).Keys.ToArray());
        public Task UpsertAsync(string domain, string id, string json, DateTimeOffset updatedAt, CancellationToken cancellationToken = default) { GetDomain(domain)[id] = json; return Task.CompletedTask; }
        public Task DeleteAsync(string domain, string id, CancellationToken cancellationToken = default) { GetDomain(domain).Remove(id); return Task.CompletedTask; }
        public Task ApplyAsync(IReadOnlyList<AtomicMutation> mutations, CancellationToken cancellationToken = default)
        {
            if (FailAtomic) throw new InvalidOperationException("simulated sqlite commit failure");
            foreach (var mutation in mutations)
            {
                if (mutation.Kind == AtomicMutationKind.DeleteDomain) GetDomain(mutation.Name).Remove(mutation.Id);
                else if (mutation.Kind == AtomicMutationKind.UpsertDomain) GetDomain(mutation.Name)[mutation.Id] = mutation.Json!;
                else throw new NotSupportedException();
            }
            return Task.CompletedTask;
        }
        private Dictionary<string, string> GetDomain(string domain) => values.TryGetValue(domain, out var result) ? result : values[domain] = new(StringComparer.OrdinalIgnoreCase);
    }

    private sealed class TestChatStore : IChatStore
    {
        public Task<long> AppendAsync(ChatMessageDto message, CancellationToken cancellationToken = default) => Task.FromResult(0L);
        public Task<bool> UpdateMetadataAsync(long messageId, string metadataJson, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task<IReadOnlyList<ChatMessageDto>> LoadRecentAsync(string conversationId, int limit, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<ChatMessageDto>>([]);
        public Task DeleteConversationAsync(string conversationId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task DeleteByCharacterAsync(string characterId, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class SqliteVoiceCacheFixture : IAsyncDisposable
    {
        private readonly string root;
        public IDomainDocumentStore Documents { get; }
        public PetVoiceMenuApplicationService Service { get; }

        private SqliteVoiceCacheFixture(string root, IDomainDocumentStore documents, PetVoiceMenuApplicationService service)
        {
            this.root = root;
            Documents = documents;
            Service = service;
        }

        public static async Task<SqliteVoiceCacheFixture> CreateAsync(string linesJson)
        {
            var root = Path.Combine(Path.GetTempPath(), "AIMaidVoiceCacheSqliteTests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var store = new SqliteCoreStore(new CoreStorageOptions(Path.Combine(root, "aimaid-core.db")));
            await store.InitializeAsync();
            ICharacterStore characters = store;
            ISettingsStore settings = store;
            IDomainDocumentStore documents = store;
            IAtomicStore atomic = store;
            var now = DateTimeOffset.Now;
            await characters.UpsertAsync(new CharacterDto("role-a", "测试角色", "", "", "", "{\"name\":\"测试角色\"}", "{\"systemPrompt\":\"测试\"}",
                "voice-a", "valid", true, now, CardSchemaVersion: "v1", TemplateCardSourceHash: "source-a"));
            await documents.UpsertAsync("voice_role_voice", "legacy_role_voice_1", JsonSerializer.Serialize(new RoleVoiceDto("role-a", "voice-a", "normal", true, true, now)), now);
            await documents.UpsertAsync("llm_business_model", "lazy_voice_cache", JsonSerializer.Serialize(new LlmBusinessModelConfigDto("lazy_voice_cache", "缓存", "", "", "model-a", true, now, now)), now);
            await documents.UpsertAsync("llm_source_prompt", "lazy_voice_lines", JsonSerializer.Serialize(new LlmSourcePromptDto("lazy_voice_lines", "", "", "", "{}", true, now, now)), now);
            await documents.UpsertAsync("model_configuration", "model-a", JsonSerializer.Serialize(new ModelConfigurationDto("model-a", "openai", "https://example.test", "test", "", false, false)), now);
            await settings.SetManyAsync(new Dictionary<string, string>
            {
                ["voice_current_role_id"] = "role-a", ["voice_cache_period_hours"] = "1",
                ["user_config:App:Tts:Enabled"] = "true", ["user_config:App:Tts:VoiceId"] = "voice-a"
            });
            var paths = ApplicationPaths.Create(root, root, root, root, root);
            var ai = new TestAi(linesJson);
            var tts = new TestTts(root);
            var events = new InProcessEventPublisher();
            var templateCards = new TemplateCardApplicationService(characters, documents, ai, events);
            var service = new PetVoiceMenuApplicationService(characters, settings, documents, atomic, events, ai, tts, templateCards, paths);
            return new SqliteVoiceCacheFixture(root, documents, service);
        }

        public async ValueTask DisposeAsync()
        {
            await Service.DisposeAsync();
            SqliteConnection.ClearAllPools();
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
