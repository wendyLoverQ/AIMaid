using System.Text.Json;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class DbQueryAgentExecutor(IChatSearchStore chats) : IAgentCapabilityExecutor
{
    public string ExecutorType => "db_query";
    public async Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        using var configDocument = JsonDocument.Parse(capability.ConfigJson);
        var queryName = configDocument.RootElement.TryGetProperty("queryName", out var query) ? query.GetString() : null;
        if (!string.Equals(queryName, "search_chat_history", StringComparison.OrdinalIgnoreCase))
            return new AgentExecutionResult(null, string.Empty, $"未注册的查询：{queryName}");
        using var argsDocument = JsonDocument.Parse(argsJson);
        var args = argsDocument.RootElement;
        var keyword = args.TryGetProperty("keyword", out var keywordValue) ? keywordValue.GetString() ?? string.Empty : string.Empty;
        if (string.IsNullOrWhiteSpace(keyword)) return new AgentExecutionResult(null, string.Empty, "缺少 keyword 参数。");
        var limit = args.TryGetProperty("limit", out var limitValue) && limitValue.TryGetInt32(out var configuredLimit) ? Math.Clamp(configuredLimit, 1, 20) : 5;
        var messages = await chats.SearchUserMessagesAsync(keyword, limit, cancellationToken);
        var output = JsonSerializer.Serialize(messages.Select(message => new { role = message.Role, content = message.Content, createdAt = message.CreatedAt }));
        return new AgentExecutionResult(0, output, string.Empty);
    }
}
