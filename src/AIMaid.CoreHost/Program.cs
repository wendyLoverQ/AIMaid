using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using AIMaid.Core;
using AIMaid.CoreHost.Protocol;
using AIMaid.CoreHost.Runtime;
using AIMaid.Infrastructure;
using AIMaid.Platform.Windows;

Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);

try
{
    var startup = Stopwatch.StartNew();
    CoreLog.Write(Console.Error, "info", "startup_begin", "Core startup began",
        data: new { runtime = RuntimeInformation.FrameworkDescription, platform = Environment.OSVersion.Platform.ToString(), arch = RuntimeInformation.ProcessArchitecture.ToString() });
    var paths = ApplicationPaths.FromEnvironment();
    paths.EnsureWritableDirectories();
    CoreLog.Write(Console.Error, "info", "startup_paths_ready", "Core writable directories initialized",
        durationMs: startup.Elapsed.TotalMilliseconds);
    if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("AIMaid CoreHost 需要 Windows DPAPI。");
    var vaultKey = WindowsSecretProtectionKeyStore.LoadOrCreate(paths);
    var secretProtector = new AesGcmSecretProtector(new SecretProtectionOptions(vaultKey));
    var storage = CoreStorageOptions.From(paths);
    await using var dataSync = new BusinessDataSyncService(
        BusinessDataSyncOptions.LegacyDefault,
        paths,
        storage.DatabasePath,
        (message, exception) => CoreLog.Write(
            Console.Error,
            exception is null ? "info" : "warning",
            "business_data_sync",
            message,
            exception: exception));
    var store = new SqliteCoreStore(storage, secretProtector, dataSync);
    await store.InitializeAsync();
    await dataSync.StartAsync();
    CoreLog.Write(Console.Error, "info", "startup_store_ready", "Core data store initialized",
        durationMs: startup.Elapsed.TotalMilliseconds);
    var events = new InProcessEventPublisher();
    using var speechClient = new SettingsBackedSpeechClient(store, store, paths);
    var speech = new SpeechApplicationService(speechClient, speechClient, events);
    var settings = new SettingsApplicationService(store, events);
    var characters = new CharacterApplicationService(store, store, store, store, events, paths);
    var characterAssets = new CharacterAssetApplicationService(store, paths, store, store, events);
    using var music = new MusicApplicationService(events, store);
    using var market = new BinanceMarketApplicationService(store, store);
    market.StartLiquidationStream();
    using var statusPlatform = new WindowsStatusPlatform();
    using var statusServers = new StatusServerApplicationService();
    var codexQuota = new CodexQuotaApplicationService();
    var domains = new ExtendedDomainApplicationService(
        store,
        secretProtector,
        store,
        new UnconfiguredRemoteMediaResolver(),
        events);
    using var aiProvider = new SettingsBackedAiProviderClient(domains, store, store, store);
    var reminderVoiceCache = new ReminderVoiceCacheService(
        aiProvider,
        speechClient,
        store,
        store,
        paths,
        (message, exception) => CoreLog.Write(Console.Error, "warning", "reminder_voice_cache", message, exception: exception));
    var reminders = new ReminderApplicationService(store, events, reminderVoiceCache);
    var proactive = new ProactiveApplicationService(store, store, events, aiProvider);
    using var proactiveContext = new AIMaid.Infrastructure.ProactiveBroadcastContextService(
        store,
        store,
        (message, exception) => CoreLog.Write(Console.Error, "warning", "proactive_context", message, exception: exception));
    var proactiveTriggers = new ProactiveTriggerService(store);
    var maidActions = new MaidActionService(
        aiProvider,
        (message, exception) => CoreLog.Write(Console.Error, "warning", "proactive_action", message, exception: exception));
    await using var proactiveRuntime = new ProactiveRuntimeService(
        proactiveContext,
        proactiveTriggers,
        maidActions,
        new WindowsActivityProbe(),
        store,
        store,
        store,
        events,
        (message, exception) => CoreLog.Write(Console.Error, "warning", "proactive_runtime", message, exception: exception));
    var chat = new ChatApplicationService(store, store, aiProvider, events);
    var templateCards = new TemplateCardApplicationService(store, store, store, aiProvider, events);
    await using var templateCardRefresh = new CharacterCardTemplateRefreshService(
        templateCards,
        (message, exception) => CoreLog.Write(Console.Error, "warning", "template_card_auto_refresh", message, exception: exception));
    await templateCardRefresh.StartAsync();
    await using var petVoiceMenu = new PetVoiceMenuApplicationService(store, store, store, store, events, aiProvider, speechClient, templateCards, paths);
    var status = new StatusApplicationService(statusPlatform, store, store, store, petVoiceMenu);
    using var httpAgentExecutor = new HttpApiAgentExecutor();
    var agent = new AgentApplicationService(store,
    [
        new ExternalProgramAgentExecutor(),
        new ScriptAgentExecutor(),
        new ProcessQueryAgentExecutor(),
        new ProcessKillAgentExecutor(),
        new TcpCheckAgentExecutor(),
        httpAgentExecutor,
        new InternalServiceAgentExecutor(reminders, speechClient, music),
        new DbQueryAgentExecutor(store),
        new InternalUiAgentExecutor(events)
    ], events, aiProvider, store, store, store);
    var scripts = new ChatCommandLauncherApplicationService(store);
    var subtitles = new SubtitleApplicationService(paths);
    var videos = new VideoLibraryApplicationService(store, store, new WindowsProcessController(), paths);
    var remoteVideos = new RemoteVideoApplicationService(store, store, secretProtector, new WindowsRemoteVideoPlatform(), paths);
    var vaultExport = new VaultExportApplicationService(store, secretProtector, new WindowsVaultArchivePlatform());
    var version = Assembly.GetExecutingAssembly()
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.1.0";
    var writer = new ProtocolWriter(Console.Out);
    CoreLog.Write(Console.Error, "info", "startup_services_ready", "Core services initialized",
        durationMs: startup.Elapsed.TotalMilliseconds, data: new { coreVersion = version, protocolVersion = ProtocolConstants.Version });
    var host = new CoreProtocolHost(Console.In, writer, settings, reminders, characters, characterAssets, templateCards, agent, petVoiceMenu, music, market, status, proactive, proactiveRuntime, statusServers, codexQuota, subtitles, videos, chat, speech, speechClient, scripts, store, store, domains, remoteVideos, vaultExport, events, version, Console.Error);
    using var shutdown = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) => { eventArgs.Cancel = true; shutdown.Cancel(); };
    return await host.RunAsync(shutdown.Token);
}
catch (Exception exception)
{
    CoreLog.Write(Console.Error, "error", "startup_failed", "Core startup failed", status: "failed", exception: exception);
    return 1;
}
