using System.Text.Json;
using AIMaid.Contracts.Status;

namespace AIMaid.CoreHost.Runtime;

public sealed class StatusServerApplicationService : IDisposable
{
    private static readonly Uri TencentCloudUrl = new("http://124.222.185.195");
    private static readonly Uri AwsUrl = new("http://35.78.120.126");
    private readonly HttpClient httpClient = new();

    public async Task<ServerHealthSnapshotDto> GetHealthAsync(CancellationToken cancellationToken = default)
    {
        var tencent = CheckHealthAsync(TencentCloudUrl, cancellationToken);
        var aws = CheckHealthAsync(AwsUrl, cancellationToken);
        await Task.WhenAll(tencent, aws);
        return new ServerHealthSnapshotDto(await tencent, await aws);
    }

    public async Task<ServerSummarySnapshotDto> GetSummaryAsync(CancellationToken cancellationToken = default)
    {
        var tencent = LoadSummaryAsync(TencentCloudUrl, cancellationToken);
        var aws = LoadSummaryAsync(AwsUrl, cancellationToken);
        await Task.WhenAll(tencent, aws);
        return new ServerSummarySnapshotDto(await tencent, await aws);
    }

    private async Task<bool> CheckHealthAsync(Uri baseUri, CancellationToken cancellationToken)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            using var response = await httpClient.GetAsync(new Uri(baseUri, "/api/health"), HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return false;
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);
            var root = document.RootElement;
            if (root.TryGetProperty("code", out var code) && code.TryGetInt32(out var codeValue) && codeValue is < 200 or >= 300) return false;
            var payload = root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object ? data : root;
            return payload.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.String &&
                   string.Equals(status.GetString(), "ok", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException or JsonException)
        {
            return false;
        }
    }

    private async Task<ServerMonitorSummaryDto?> LoadSummaryAsync(Uri baseUri, CancellationToken cancellationToken)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            using var response = await httpClient.GetAsync(new Uri(baseUri, "/api/monitor/summary"), HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);
            var root = document.RootElement;
            var payload = root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object ? data : root;
            return new ServerMonitorSummaryDto(
                ReadCapacity(payload, "memory"),
                ReadCapacity(payload, "disk"),
                ReadCapacity(payload, "traffic"));
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException or JsonException)
        {
            return null;
        }
    }

    private static ServerCapacityMetricDto? ReadCapacity(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Object ||
            !value.TryGetProperty("usedBytes", out var used) || !used.TryGetInt64(out var usedBytes) ||
            !value.TryGetProperty("totalBytes", out var total) || !total.TryGetInt64(out var totalBytes)) return null;
        return new ServerCapacityMetricDto(usedBytes, totalBytes);
    }

    public void Dispose() => httpClient.Dispose();
}
