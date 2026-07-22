using AIMaid.Core;

namespace AIMaid.Infrastructure;

public sealed record CoreStorageOptions(string DatabasePath)
{
    public static CoreStorageOptions From(ApplicationPaths paths) => new(paths.Data("aimaid-core.db"));
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
