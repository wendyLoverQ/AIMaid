using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Domains;
using AIMaid.Contracts.Settings;
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

    private static string CreateLinesJson(int count = 9)
    {
        var lines = PetVoiceTriggerCatalog.Plans.Take(count).Select((plan, index) => new
        {
            key = plan.Key,
            text = $"语音缓存测试台词 {index + 1}",
            voiceStyle = plan.SuggestedStyle
        });
        return JsonSerializer.Serialize(new { lines });
    }

    private sealed class VoiceCacheFixture : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "AIMaidVoiceCacheTests", Guid.NewGuid().ToString("N"));
        public TestDocuments Documents { get; } = new();
        public TestCharacters Characters { get; }
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
            var settings = new TestSettings(new Dictionary<string, string>
            {
                ["voice_current_role_id"] = "role-a", ["voice_cache_period_hours"] = "1",
                ["user_config:App:Tts:Enabled"] = "true", ["user_config:App:Tts:VoiceId"] = "voice-a"
            });
            Ai = ai ?? new TestAi(linesJson);
            Tts = new TestTts(root);
            var events = new InProcessEventPublisher();
            var templateCards = new TemplateCardApplicationService(Characters, Documents, Ai, events);
            Service = new PetVoiceMenuApplicationService(Characters, settings, Documents, Documents, events, Ai, Tts, templateCards, Paths);
        }

        public void Dispose()
        {
            Service.DisposeAsync().AsTask().GetAwaiter().GetResult();
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private sealed class TestAi(string response, TaskCompletionSource? firstCallStarted = null, bool blockFirstCall = false) : IAiProviderClient
    {
        private int calls;
        public int Calls => Volatile.Read(ref calls);
        public async IAsyncEnumerable<string> StreamChatAsync(AiChatRequest request, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            var call = Interlocked.Increment(ref calls);
            if (call == 1) firstCallStarted?.TrySetResult();
            cancellationToken.ThrowIfCancellationRequested();
            if (call == 1 && blockFirstCall) await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            yield return response;
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
            File.WriteAllBytes(path, [1, 2, 3]);
            return Task.FromResult(path);
        }
    }

    private sealed class TestCharacters(CharacterDto character) : ICharacterStore
    {
        private CharacterDto value = character;
        public Task<CharacterDto?> GetAsync(string roleId, CancellationToken cancellationToken = default) => Task.FromResult<CharacterDto?>(value.RoleId == roleId ? value : null);
        public Task<IReadOnlyList<CharacterDto>> ListAsync(bool enabledOnly, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CharacterDto>>([value]);
        public Task UpsertAsync(CharacterDto character, CancellationToken cancellationToken = default) { value = character; return Task.CompletedTask; }
        public Task DeleteAsync(string roleId, CancellationToken cancellationToken = default) { throw new NotSupportedException(); }
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
