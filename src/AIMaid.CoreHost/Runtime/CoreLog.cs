using System.Text.Json;
using System.Text.RegularExpressions;

namespace AIMaid.CoreHost.Runtime;

internal static partial class CoreLog
{
    public static void Write(
        TextWriter output,
        string level,
        string eventName,
        string message,
        string? requestId = null,
        string? requestType = null,
        string? status = null,
        double? durationMs = null,
        object? data = null,
        Exception? exception = null)
    {
        var record = new Dictionary<string, object?>
        {
            ["timestamp"] = DateTimeOffset.UtcNow,
            ["level"] = level,
            ["scope"] = "core",
            ["eventName"] = eventName,
            ["message"] = RedactText(message),
            ["processId"] = Environment.ProcessId
        };
        if (requestId is not null) record["requestId"] = requestId;
        if (requestType is not null) record["requestType"] = requestType;
        if (status is not null) record["status"] = status;
        if (durationMs is not null) record["durationMs"] = Math.Round(durationMs.Value, 2);
        if (data is not null) record["data"] = RedactValue(JsonSerializer.SerializeToElement(data));
        if (exception is not null)
        {
            record["error"] = new
            {
                name = exception.GetType().Name,
                message = RedactText(exception.Message),
                stack = RedactText(exception.StackTrace ?? string.Empty)
            };
        }
        output.WriteLine(JsonSerializer.Serialize(record));
        output.Flush();
    }

    private static object? RedactValue(JsonElement value, int depth = 0)
    {
        if (depth >= 8) return "[MAX_DEPTH]";
        return value.ValueKind switch
        {
            JsonValueKind.Object => value.EnumerateObject().ToDictionary(
                property => property.Name,
                property => IsSensitiveKey(property.Name) ? (object?)"[REDACTED]" : RedactValue(property.Value, depth + 1)),
            JsonValueKind.Array => value.EnumerateArray().Select(item => RedactValue(item, depth + 1)).ToArray(),
            JsonValueKind.String => RedactText(value.GetString() ?? string.Empty),
            JsonValueKind.Number => value.TryGetInt64(out var integer) ? integer : value.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static bool IsSensitiveKey(string key)
    {
        var normalized = CamelCaseBoundary().Replace(key, "$1_$2");
        return SensitiveKey().IsMatch(normalized);
    }

    private static string RedactText(string value)
        => UrlCredential().Replace(
            EmbeddedSecret().Replace(
                Authorization().Replace(SensitiveQuery().Replace(value, "$1[REDACTED]"), "$1 [REDACTED]"),
                "$1[REDACTED]"),
            "$1[REDACTED]@");

    [GeneratedRegex("([a-z0-9])([A-Z])")]
    private static partial Regex CamelCaseBoundary();

    [GeneratedRegex("(?:^|[_\\-.])(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|secret|private[_-]?key|token|key)(?:$|[_\\-.])", RegexOptions.IgnoreCase)]
    private static partial Regex SensitiveKey();

    [GeneratedRegex("([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password)=)[^&#\\s]*", RegexOptions.IgnoreCase)]
    private static partial Regex SensitiveQuery();

    [GeneratedRegex("\\b(Bearer|Basic)\\s+[A-Za-z0-9._~+\\-/=]+", RegexOptions.IgnoreCase)]
    private static partial Regex Authorization();

    [GeneratedRegex("\\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|authorization)\\s*[:=]\\s*)([^\\s,;&#]+)", RegexOptions.IgnoreCase)]
    private static partial Regex EmbeddedSecret();

    [GeneratedRegex("(https?://)[^/@\\s:]+:[^/@\\s]+@", RegexOptions.IgnoreCase)]
    private static partial Regex UrlCredential();
}
