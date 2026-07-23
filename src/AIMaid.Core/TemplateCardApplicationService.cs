using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class TemplateCardApplicationService(
    ICharacterStore characters,
    IDomainDocumentStore documents,
    IAiProviderClient aiProvider) :
    ICommandHandler<GenerateTemplateCardCommand, OperationResult<CharacterDto>>
{
    private const string SourcePromptDomain = "llm_source_prompt";
    private const string BusinessModelDomain = "llm_business_model";
    private const string ModelConfigurationDomain = "model_configuration";
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Gates = new(StringComparer.OrdinalIgnoreCase);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };

    public async Task<OperationResult<CharacterDto>> HandleAsync(GenerateTemplateCardCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.RoleId))
            return OperationResult<CharacterDto>.Failure("character.invalid_role", "角色 ID 不能为空。");
        var gate = Gates.GetOrAdd(command.RoleId.Trim(), _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var role = await characters.GetAsync(command.RoleId.Trim(), cancellationToken);
            if (role is null) return OperationResult<CharacterDto>.Failure("character.not_found", "角色不存在。");
            if (string.IsNullOrWhiteSpace(role.SourceCardJson))
                return OperationResult<CharacterDto>.Failure("character.source_card_missing", $"角色 SourceCardJson 为空：{role.RoleId}");
            if (command.ContinueIteration && string.IsNullOrWhiteSpace(role.TemplateCardJson))
                return OperationResult<CharacterDto>.Failure("character.template_missing", $"当前角色卡尚未生成，不能继续迭代：{role.RoleId}");

            var sourcePrompt = await LoadSourcePromptAsync(cancellationToken);
            var modelName = await LoadModelNameAsync(cancellationToken);
            var hadTemplate = !string.IsNullOrWhiteSpace(role.TemplateCardJson);
            var input = command.ContinueIteration ? role.TemplateCardJson : role.SourceCardJson;
            var inputKind = command.ContinueIteration ? "当前角色卡（在上一版基础上继续迭代）" : "原角色卡（从原始设定开始生成）";
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
                                           conversationId, userPrompt, role.RoleId, modelName, promptHistory), cancellationToken)) response.Append(delta);
                        var templateJson = ValidateTemplateJson(response.ToString());
                        role = role with {
                            TemplateCardJson = templateJson,
                            TemplateCardGeneratedAt = DateTimeOffset.Now,
                            TemplateCardIterationCount = command.ContinueIteration ? checked(role.TemplateCardIterationCount + 1) : 0,
                            TemplateCardSourceHash = sourceHash,
                            TemplateCardGenerationStatus = "ready",
                            TemplateCardGenerationMessage = "",
                            UpdatedAt = DateTimeOffset.Now
                        };
                        await characters.UpsertAsync(role, cancellationToken);
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
        if (json is not null)
        {
            var saved = JsonSerializer.Deserialize<LlmSourcePromptDto>(json, JsonOptions);
            if (saved is not null && saved.IsEnabled && !IsLegacyIncompatiblePrompt(saved)) return saved;
            if (saved is not null && saved.IsEnabled)
            {
                var upgraded = BuildDefaultSourcePrompt(saved.CreatedAt, DateTimeOffset.Now);
                await documents.UpsertAsync(SourcePromptDomain, upgraded.SourceKey,
                    JsonSerializer.Serialize(upgraded, JsonConfig.Persistence), upgraded.UpdatedAt, cancellationToken);
                return upgraded;
            }
            throw new InvalidOperationException("角色卡生成 Source Prompt 已停用或无效。");
        }
        var now = DateTimeOffset.Now;
        var seeded = BuildDefaultSourcePrompt(now, now);
        await documents.UpsertAsync(SourcePromptDomain, seeded.SourceKey, JsonSerializer.Serialize(seeded, JsonConfig.Persistence), now, cancellationToken);
        return seeded;
    }

    private static bool IsLegacyIncompatiblePrompt(LlmSourcePromptDto prompt)
        => prompt.SystemPromptTemplate.Contains("system_prompt", StringComparison.OrdinalIgnoreCase) ||
           prompt.SystemPromptTemplate.Contains("nsfw_guidance", StringComparison.OrdinalIgnoreCase) ||
           !prompt.OutputSchemaJson.Contains("systemPrompt", StringComparison.Ordinal);

    private static LlmSourcePromptDto BuildDefaultSourcePrompt(DateTimeOffset createdAt, DateTimeOffset updatedAt)
        => new(
            "character_card_template_generation", "根据原角色卡生成当前角色卡，或基于当前角色卡继续迭代",
            """
            你是角色卡扩写与迭代器。根据用户提供的输入角色卡 JSON 生成下一版严格合法的 JSON 对象。
            输入为原角色卡时，从原始设定扩写；输入为当前角色卡时，在上一版基础上继续补全和优化。
            必须保留输入角色卡的事实、关系、语气和内容边界，不得改变角色身份，不得混入其他角色。
            不得新增或保留露骨性内容；年龄不明或未成年角色不得包含任何性内容。
            在不与源卡冲突的前提下，补全稳定的人格、语言习惯、称呼规则、关系规则、互动策略、禁忌、场景响应和少量示例。
            必须生成非空 systemPrompt 字段。只输出 JSON 对象，不要 Markdown、代码块、解释或前后缀。
            【输出结构】
            {outputSchemaJson}
            """.Trim(),
            """
            【角色】
            roleId={roleId}
            roleName={roleName}
            【输入类型】
            {inputCardKind}
            【输入角色卡 JSON】
            {inputCardJson}
            """.Trim(),
            "{\"name\":\"string\",\"systemPrompt\":\"string\",\"identity\":{},\"personality\":{},\"relationToUser\":{},\"speechStyle\":{},\"interactionPolicy\":{},\"boundaries\":{},\"scenarios\":[],\"examples\":[]}",
            true, createdAt, updatedAt);

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

    private static string ValidateTemplateJson(string raw)
    {
        var json = raw.Trim();
        if (json.StartsWith("```", StringComparison.Ordinal))
        {
            var firstNewline = json.IndexOf('\n');
            var lastFence = json.LastIndexOf("```", StringComparison.Ordinal);
            if (firstNewline >= 0 && lastFence > firstNewline) json = json[(firstNewline + 1)..lastFence].Trim();
        }
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("模型返回内容不是 JSON 对象。");
        if (!document.RootElement.TryGetProperty("systemPrompt", out var prompt) || prompt.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(prompt.GetString()))
            throw new InvalidDataException("模型返回的角色卡缺少非空 systemPrompt。");
        return JsonSerializer.Serialize(document.RootElement, new JsonSerializerOptions { WriteIndented = false });
    }
}
