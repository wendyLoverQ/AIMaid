using System.Text.Json;

namespace AIMaid.CoreHost.Protocol;

public sealed class ProtocolWriter
{
    private readonly TextWriter output;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly JsonSerializerOptions options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    public ProtocolWriter(TextWriter output) => this.output = output;

    public Task SuccessAsync(ProtocolRequest request, object? payload, CancellationToken cancellationToken = default)
        => WriteAsync(new ProtocolResponse(ProtocolConstants.Version, request.Id, "response", request.Type,
            DateTimeOffset.UtcNow, true, payload, null), cancellationToken);

    public Task FailureAsync(ProtocolRequest request, string code, string message,
        IReadOnlyDictionary<string, object?>? details = null, CancellationToken cancellationToken = default)
        => WriteAsync(new ProtocolResponse(ProtocolConstants.Version, request.Id, "response", request.Type,
            DateTimeOffset.UtcNow, false, null, new(code, message, details ?? new Dictionary<string, object?>())), cancellationToken);

    public Task EventAsync(string type, string? correlationId, long sequence, object? payload,
        CancellationToken cancellationToken = default)
        => WriteAsync(new ProtocolEvent(ProtocolConstants.Version, $"evt_{Guid.NewGuid():N}", "event", type,
            DateTimeOffset.UtcNow, correlationId, sequence, payload), cancellationToken);

    private async Task WriteAsync<T>(T message, CancellationToken cancellationToken)
    {
        var line = JsonSerializer.Serialize(message, options);
        await gate.WaitAsync(cancellationToken);
        try
        {
            await output.WriteLineAsync(line.AsMemory(), cancellationToken);
            await output.FlushAsync(cancellationToken);
        }
        finally { gate.Release(); }
    }
}
