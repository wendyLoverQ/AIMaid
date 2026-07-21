namespace AIMaid.Infrastructure;

public sealed record CoreStorageOptions(string DatabasePath);
public sealed record AiProviderOptions(Uri Endpoint, string Model, string? ApiKey = null);
public sealed record ComfyUiOptions(Uri BaseAddress);
public sealed record SpeechServiceOptions(Uri BaseAddress, string OutputDirectory);
