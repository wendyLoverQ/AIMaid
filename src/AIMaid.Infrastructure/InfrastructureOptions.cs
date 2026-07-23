using AIMaid.Core;

namespace AIMaid.Infrastructure;

public sealed record CoreStorageOptions(string DatabasePath)
{
    public static CoreStorageOptions From(ApplicationPaths paths) => new(paths.Data("aimaid-core.db"));
}
public sealed record BusinessDataSyncOptions(
    bool Enabled,
    Uri ServerUrl,
    int UserId,
    string DeviceId,
    int BatchSize)
{
    public static BusinessDataSyncOptions LegacyDefault { get; } = new(
        true,
        new Uri("http://35.78.120.126"),
        0,
        "aimaid-main-pc",
        100);
}
public sealed record AiProviderOptions(
    Uri Endpoint,
    string Model,
    string? ApiKey = null,
    string? ReasoningEffort = null);
public sealed record ComfyUiOptions(Uri BaseAddress);
public sealed record SpeechServiceOptions(Uri BaseAddress, string OutputDirectory)
{
    public static SpeechServiceOptions From(ApplicationPaths paths, Uri baseAddress) => new(baseAddress, paths.Cache("tts"));
}
public sealed record SecretProtectionOptions(string KeyBase64);
