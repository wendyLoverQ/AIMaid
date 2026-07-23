using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class TemplateCardApplicationService(
    ICharacterStore characters,
    ISettingsStore settings,
    IDomainDocumentStore documents,
    IAiProviderClient aiProvider,
    IEventPublisher events) :
    ICommandHandler<GenerateTemplateCardCommand, OperationResult<CharacterDto>>
{
    private const string SourcePromptDomain = "llm_source_prompt";
    private const string BusinessModelDomain = "llm_business_model";
    private const string ModelConfigurationDomain = "model_configuration";
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Gates = new(StringComparer.OrdinalIgnoreCase);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };

    public async Task<OperationResult<CharacterDto>> RefreshCurrentRoleAsync(CancellationToken cancellationToken = default)
    {
        var roleId = (await settings.GetAsync("voice_current_role_id", cancellationToken))?.Value?.Trim();
        if (string.IsNullOrWhiteSpace(roleId))
            return OperationResult<CharacterDto>.Success(null!);

        var intervalValue = (await settings.GetAsync("user_config:App:CharacterCardTemplate:RefreshIntervalHours", cancellationToken))?.Value;
        if (!TryParseRefreshIntervalHours(intervalValue, out var intervalHours))
            return OperationResult<CharacterDto>.Failure(
                "character.invalid_refresh_interval",
                "角色模板刷新周期必须是 1 到 720 小时之间的整数。");
        var role = await characters.GetAsync(roleId, cancellationToken);
        if (role is null)
            return OperationResult<CharacterDto>.Failure("character.not_found", $"角色不存在：{roleId}");
        if (string.IsNullOrWhiteSpace(role.SourceCardJson))
            return OperationResult<CharacterDto>.Failure("character.source_card_missing", $"角色 SourceCardJson 为空：{role.RoleId}");

        var sourceHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(role.SourceCardJson)));
        if (string.IsNullOrWhiteSpace(role.TemplateCardJson))
            return await GenerateAsync(role.RoleId, continueIteration: false, cancellationToken);
        if (!string.Equals(sourceHash, role.TemplateCardSourceHash, StringComparison.OrdinalIgnoreCase))
            return await GenerateAsync(role.RoleId, continueIteration: false, cancellationToken);
        if (role.TemplateCardGeneratedAt is not null &&
            role.TemplateCardGeneratedAt.Value + TimeSpan.FromHours(intervalHours) > DateTimeOffset.Now)
            return OperationResult<CharacterDto>.Success(role);

        return await GenerateAsync(role.RoleId, continueIteration: true, cancellationToken);
    }

    public async Task<OperationResult<CharacterDto>> HandleAsync(GenerateTemplateCardCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.RoleId))
            return OperationResult<CharacterDto>.Failure("character.invalid_role", "角色 ID 不能为空。");
        return await GenerateAsync(command.RoleId, command.ContinueIteration, cancellationToken);
    }

    private async Task<OperationResult<CharacterDto>> GenerateAsync(string roleId, bool continueIteration, CancellationToken cancellationToken)
    {
        var normalizedRoleId = roleId.Trim();
        var gate = Gates.GetOrAdd(normalizedRoleId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var role = await characters.GetAsync(normalizedRoleId, cancellationToken);
            if (role is null) return OperationResult<CharacterDto>.Failure("character.not_found", "角色不存在。");
            if (string.IsNullOrWhiteSpace(role.SourceCardJson))
                return OperationResult<CharacterDto>.Failure("character.source_card_missing", $"角色 SourceCardJson 为空：{role.RoleId}");
            if (continueIteration && string.IsNullOrWhiteSpace(role.TemplateCardJson))
                return OperationResult<CharacterDto>.Failure("character.template_missing", $"当前角色卡尚未生成，不能继续迭代：{role.RoleId}");

            var sourcePrompt = await LoadSourcePromptAsync(cancellationToken);
            var modelName = await LoadModelNameAsync(cancellationToken);
            var hadTemplate = !string.IsNullOrWhiteSpace(role.TemplateCardJson);
            var input = continueIteration ? role.TemplateCardJson : role.SourceCardJson;
            var inputKind = continueIteration ? "当前角色卡（在上一版基础上继续迭代）" : "原角色卡（从原始设定开始生成）";
            var sourceHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(role.SourceCardJson)));
            role = role with { TemplateCardGenerationStatus = "generating", TemplateCardGenerationMessage = "", TemplateCardLastAttemptAt = DateTimeOffset.Now, UpdatedAt = DateTimeOffset.Now };
            await characters.UpsertAsync(role, cancellationToken);

            try
            {
                Exception? lastError = null;
                for (var attempt = 1; attempt <= 3; attempt++)
                {
                    try
                    {
                        var systemPrompt = sourcePrompt.SystemPromptTemplate.Replace("{outputSchemaJson}", sourcePrompt.OutputSchemaJson, StringComparison.Ordinal).Trim();
                        var userPrompt = sourcePrompt.UserPromptTemplate
                            .Replace("{roleId}", role.RoleId, StringComparison.Ordinal)
                            .Replace("{roleName}", role.Name, StringComparison.Ordinal)
                            .Replace("{inputCardKind}", inputKind, StringComparison.Ordinal)
                            .Replace("{inputCardJson}", input, StringComparison.Ordinal)
                            .Replace("{sourceCardJson}", input, StringComparison.Ordinal).Trim();
                        var response = new StringBuilder();
                        var conversationId = $"character_card_template_{role.RoleId}_{Guid.NewGuid():N}";
                        var promptHistory = new ChatMessageDto[]
                        {
                            new(0, conversationId, "system", systemPrompt, role.RoleId, modelName, "source_prompt:character_card_template_generation", "", DateTimeOffset.Now),
                            new(0, conversationId, "user", userPrompt, role.RoleId, modelName, "character_card_template_generation", "", DateTimeOffset.Now)
                        };
                        await foreach (var delta in aiProvider.StreamChatAsync(new AiChatRequest(
                                           conversationId, userPrompt, role.RoleId, modelName, promptHistory,
                                           SourceKey: "character_card_template_generation",
                                           StreamResponse: false), cancellationToken)) response.Append(delta);
                        var templateJson = ValidateTemplateCardJson(response.ToString());
                        role = role with {
                            TemplateCardJson = templateJson,
                            TemplateCardGeneratedAt = DateTimeOffset.Now,
                            TemplateCardIterationCount = continueIteration ? checked(role.TemplateCardIterationCount + 1) : 0,
                            TemplateCardSourceHash = sourceHash,
                            TemplateCardGenerationStatus = "ready",
                            TemplateCardGenerationMessage = "",
                            UpdatedAt = DateTimeOffset.Now
                        };
                        await characters.UpsertAsync(role, cancellationToken);
                        await events.PublishAsync(new CharacterChangedEvent(EventIdentity.NewId(), DateTimeOffset.Now, role.RoleId, "template_changed"), cancellationToken);
                        return OperationResult<CharacterDto>.Success(role);
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception exception) when (attempt < 3)
                    {
                        lastError = exception;
                        await Task.Delay(TimeSpan.FromSeconds(attempt), cancellationToken);
                    }
                    catch (Exception exception) { lastError = exception; }
                }
                throw new InvalidOperationException("连续 3 次生成均失败。", lastError);
            }
            catch (OperationCanceledException)
            {
                role = await PersistFailureAsync(role, hadTemplate, "角色模板生成已取消。", CancellationToken.None);
                throw;
            }
            catch (Exception exception)
            {
                role = await PersistFailureAsync(role, hadTemplate, exception.Message, CancellationToken.None);
                return OperationResult<CharacterDto>.Failure("character.template_generation_failed", $"角色模板生成失败：{role.RoleId}。{exception.Message}");
            }
        }
        finally { gate.Release(); }
    }

    private async Task<CharacterDto> PersistFailureAsync(CharacterDto role, bool hadTemplate, string message, CancellationToken cancellationToken)
    {
        var saved = role with {
            TemplateCardGenerationStatus = hadTemplate ? "ready" : "failed",
            TemplateCardGenerationMessage = hadTemplate ? $"本次生成失败，已保留上一版当前角色卡：{message}" : message,
            UpdatedAt = DateTimeOffset.Now
        };
        await characters.UpsertAsync(saved, cancellationToken);
        return saved;
    }

    private async Task<LlmSourcePromptDto> LoadSourcePromptAsync(CancellationToken cancellationToken)
    {
        var json = await documents.GetAsync(SourcePromptDomain, "character_card_template_generation", cancellationToken);
        var saved = json is null ? null : JsonSerializer.Deserialize<LlmSourcePromptDto>(json, JsonOptions);
        if (saved is null || !saved.IsEnabled ||
            string.IsNullOrWhiteSpace(saved.SystemPromptTemplate) ||
            string.IsNullOrWhiteSpace(saved.UserPromptTemplate))
            throw new InvalidOperationException("角色卡生成 Source Prompt 未配置、已停用或内容为空。");
        return saved;
    }

    private async Task<string> LoadModelNameAsync(CancellationToken cancellationToken)
    {
        var json = await documents.GetAsync(BusinessModelDomain, "character_card_expansion", cancellationToken);
        var configuration = json is null ? null : JsonSerializer.Deserialize<LlmBusinessModelConfigDto>(json, JsonOptions);
        if (configuration is not null && configuration.IsEnabled && !string.IsNullOrWhiteSpace(configuration.ModelKey))
        {
            var modelJson = await documents.GetAsync(ModelConfigurationDomain, configuration.ModelKey, cancellationToken);
            var model = modelJson is null ? null : JsonSerializer.Deserialize<ModelConfigurationDto>(modelJson, JsonOptions);
            return string.IsNullOrWhiteSpace(model?.Model) ? configuration.ModelKey : model.Model;
        }
        return string.Empty;
    }

    private static bool TryParseRefreshIntervalHours(string? value, out int hours)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            hours = 24;
            return true;
        }

        return int.TryParse(value.Trim(), out hours) && hours is >= 1 and <= 720;
    }

    private static string ValidateTemplateCardJson(string rawText)
    {
        var json = rawText?.Trim();
        if (string.IsNullOrWhiteSpace(json))
            throw new InvalidOperationException("模型没有返回 JSON 对象。");

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException exception)
        {
            throw new InvalidOperationException("模型没有返回严格合法的 JSON 对象。", exception);
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("角色模板必须是 JSON 对象。");

            var systemPrompt = FirstJsonString(document.RootElement, "systemPrompt", "system_prompt");
            if (string.IsNullOrWhiteSpace(systemPrompt))
                throw new InvalidOperationException("角色模板缺少 systemPrompt。");

            return JsonSerializer.Serialize(document.RootElement, new JsonSerializerOptions
            {
                WriteIndented = true,
                Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
            });
        }
    }

    private static string FirstJsonString(JsonElement root, params string[] names)
    {
        foreach (var name in names)
        {
            if (root.TryGetProperty(name, out var value) &&
                value.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(value.GetString()))
                return value.GetString() ?? string.Empty;
        }
        return string.Empty;
    }

}
