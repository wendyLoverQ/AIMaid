using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Domains;
using AIMaid.Core;

namespace AIMaid.CoreHost.Runtime;

public sealed class InternalUiAgentExecutor(IEventPublisher events) : IAgentCapabilityExecutor
{
    public string ExecutorType => "internal_ui";

    public async Task<AgentExecutionResult> ExecuteAsync(
        AgentCapabilityDto capability,
        string argsJson,
        CancellationToken cancellationToken = default)
    {
        using var config = JsonDocument.Parse(capability.ConfigJson);
        var target = config.RootElement.TryGetProperty("windowType", out var value) &&
                     value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
        if (!target.Equals("settings", StringComparison.OrdinalIgnoreCase))
            return new AgentExecutionResult(null, string.Empty, $"未支持的 UI 窗口类型：{target}");

        await events.PublishAsync(new AgentUiActionRequestedEvent(
            EventIdentity.NewId(),
            DateTimeOffset.Now,
            "open_window",
            "settings"), cancellationToken);
        return new AgentExecutionResult(0, "已打开系统设置。", string.Empty);
    }
}
