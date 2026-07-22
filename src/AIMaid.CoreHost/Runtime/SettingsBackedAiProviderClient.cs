using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Domains;
using AIMaid.Contracts.Settings;
using AIMaid.Core;
using AIMaid.Infrastructure;

namespace AIMaid.CoreHost.Runtime;

public sealed class SettingsBackedAiProviderClient(
    ExtendedDomainApplicationService domains,
    ICharacterStore characters,
    ISettingsStore settings) : IAiProviderClient, IDisposable
{
    private readonly HttpClient httpClient = new();

    public async IAsyncEnumerable<string> StreamChatAsync(
        AiChatRequest request,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var models = await domains.HandleAsync(new ListModelConfigurationsQuery(IncludeSecrets: true), cancellationToken);
        var configuredKey = request.ModelName.Trim();
        if (configuredKey.Length == 0)
        {
            var business = await domains.HandleAsync(new ListLlmBusinessModelConfigsQuery(), cancellationToken);
            // The legacy Agent plans with the currently selected chat provider; the source prompt changes,
            // but the provider does not silently switch to a separately configured model.
            configuredKey = business.FirstOrDefault(item => item.IsEnabled && item.BusinessKey.Equals("chat_reply", StringComparison.OrdinalIgnoreCase))?.ModelKey ?? string.Empty;
        }
        var configuration = models.FirstOrDefault(item => item.ModelKey.Equals(configuredKey, StringComparison.OrdinalIgnoreCase))
            ?? models.FirstOrDefault(item => item.Model.Equals(configuredKey, StringComparison.OrdinalIgnoreCase));
        if (configuration is null)
            throw new InvalidOperationException(configuredKey.Length == 0
                ? "聊天回复业务尚未选择模型。"
                : $"模型配置“{configuredKey}”不存在或未启用。");
        if (string.IsNullOrWhiteSpace(configuration.Endpoint))
            throw new InvalidOperationException($"模型“{configuration.ModelKey}”尚未配置服务地址。");

        var endpoint = NormalizeEndpoint(configuration.Endpoint);
        var effectiveRequest = await ApplyChatSourcePromptAsync(request, configuration.Model, cancellationToken);
        var reasoningEffort = configuration.Type.Equals("local", StringComparison.OrdinalIgnoreCase)
            ? configuration.Think ? "medium" : "none"
            : null;
        var client = new AiProviderHttpClient(httpClient, new AiProviderOptions(
            endpoint,
            configuration.Model,
            configuration.ApiKey,
            reasoningEffort));
        await foreach (var delta in client.StreamChatAsync(effectiveRequest, cancellationToken)) yield return delta;
    }

    public void Dispose() => httpClient.Dispose();

    private async Task<AiChatRequest> ApplyChatSourcePromptAsync(AiChatRequest request, string modelName, CancellationToken cancellationToken)
    {
        if (request.ConversationId.StartsWith("character_card_template_", StringComparison.OrdinalIgnoreCase))
            return request with { ModelName = modelName };
        if (string.IsNullOrWhiteSpace(request.SourceKey)) return request with { ModelName = modelName };
        var prompts = await domains.HandleAsync(new ListLlmSourcePromptsQuery(), cancellationToken);
        var prompt = prompts.FirstOrDefault(item => item.IsEnabled && item.SourceKey.Equals(request.SourceKey, StringComparison.OrdinalIgnoreCase));
        if (prompt is null || string.IsNullOrWhiteSpace(prompt.SystemPromptTemplate)) return request with { ModelName = modelName };
        var characterId = request.CharacterId;
        if (string.IsNullOrWhiteSpace(characterId))
            characterId = (await settings.GetAsync("voice_current_role_id", cancellationToken))?.Value ?? string.Empty;
        var character = string.IsNullOrWhiteSpace(characterId) ? null : await characters.GetAsync(characterId, cancellationToken);
        var cardJson = character is null
            ? string.Empty
            : !string.IsNullOrWhiteSpace(character.TemplateCardJson) ? character.TemplateCardJson : character.SourceCardJson;
        if (string.IsNullOrWhiteSpace(cardJson))
            throw new InvalidOperationException($"角色“{characterId}”没有可用的角色卡。");
        var values = new Dictionary<string, string>(request.TemplateValues ?? new Dictionary<string, string>(), StringComparer.Ordinal)
        {
            ["characterId"] = characterId,
            ["roleId"] = characterId,
            ["roleName"] = character?.Name ?? characterId,
            ["templateCardJson"] = cardJson,
            ["outputSchemaJson"] = prompt.OutputSchemaJson,
            ["message"] = request.Content,
            ["input"] = request.Content,
            ["userMessage"] = request.Content
        };
        var system = Render(prompt.SystemPromptTemplate, values);
        var user = string.IsNullOrWhiteSpace(prompt.UserPromptTemplate) ? request.Content : Render(prompt.UserPromptTemplate, values);
        var history = new List<ChatMessageDto>
        {
            new(0, request.ConversationId, "system", system, characterId, modelName, $"source_prompt:{request.SourceKey}", string.Empty, DateTimeOffset.Now)
        };
        history.AddRange(request.History);
        history.Add(new ChatMessageDto(0, request.ConversationId, "user", user, characterId, modelName,
            $"source_prompt:{request.SourceKey}", string.Empty, DateTimeOffset.Now));
        return request with { ModelName = modelName, CharacterId = characterId, Content = user, History = history, RequireJsonResponse = true };
    }

    private static string Render(string template, IReadOnlyDictionary<string, string> values)
    {
        var rendered = template;
        foreach (var (key, value) in values) rendered = rendered.Replace($"{{{key}}}", value, StringComparison.Ordinal);
        return rendered;
    }

    private static Uri NormalizeEndpoint(string value)
    {
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var endpoint) || endpoint.Scheme is not ("http" or "https"))
            throw new InvalidOperationException("模型服务地址必须是有效的 HTTP/HTTPS URL。");
        var path = endpoint.AbsolutePath.TrimEnd('/');
        if (path.Length == 0) return new Uri(endpoint, "/v1/chat/completions");
        if (path.Equals("/v1", StringComparison.OrdinalIgnoreCase)) return new Uri(endpoint, "/v1/chat/completions");
        return endpoint;
    }
}
