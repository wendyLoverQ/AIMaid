using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using AIMaid.Contracts;
using AIMaid.Contracts.Characters;

namespace AIMaid.Core;

public sealed class CharacterAssetApplicationService(
    IDomainDocumentStore store,
    ApplicationPaths paths,
    ICharacterStore characters,
    ISettingsStore settings,
    IEventPublisher events) :
    IQueryHandler<ListVoiceAssetsQuery, IReadOnlyList<VoiceAssetDto>>,
    ICommandHandler<AddVoiceAssetCommand, OperationResult<VoiceAssetDto>>,
    ICommandHandler<ImportCharacterAvatarCommand, OperationResult<string>>,
    IQueryHandler<ListRoleVoicesQuery, IReadOnlyList<RoleVoiceDto>>,
    ICommandHandler<SetRoleVoicesCommand, OperationResult>,
    IQueryHandler<GetCharacterObjectBindingQuery, CharacterObjectBindingDto?>,
    IQueryHandler<ListCharacterObjectBindingsQuery, IReadOnlyList<CharacterObjectBindingDto>>,
    ICommandHandler<BindCharacterObjectCommand, OperationResult<CharacterObjectBindingDto>>,
    ICommandHandler<UnbindCharacterObjectCommand, OperationResult>,
    ICommandHandler<ApplyCharacterObjectBindingCommand, OperationResult>
{
    private const string CurrentRoleKey = "voice_current_role_id";
    private const string VoiceAssetDomain = "voice_asset";
    private const string RoleVoiceDomain = "voice_role_voice";
    private const string RoleBindingDomain = "voice_role_binding";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public async Task<IReadOnlyList<VoiceAssetDto>> HandleAsync(ListVoiceAssetsQuery query, CancellationToken cancellationToken = default)
        => (await store.ListAsync(VoiceAssetDomain, cancellationToken)).Select(Parse<VoiceAssetDto>)
            .Where(item => item.IsEnabled).OrderBy(item => item.DisplayName, StringComparer.CurrentCultureIgnoreCase).ToArray();

    public async Task<OperationResult<VoiceAssetDto>> HandleAsync(AddVoiceAssetCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.SourceFolderPath) || !Directory.Exists(command.SourceFolderPath))
            return OperationResult<VoiceAssetDto>.Failure("voice_asset.folder_missing", "请选择有效的音色文件夹。");
        foreach (var fileName in new[] { "meta.json", "prompt.txt", "prompt.wav" })
            if (!File.Exists(Path.Combine(command.SourceFolderPath, fileName)))
                return OperationResult<VoiceAssetDto>.Failure("voice_asset.file_missing", $"音色文件夹缺少必要文件：{fileName}");
        var baseName = TrimStyleSuffix(Sanitize(command.BaseName));
        if (baseName.Length == 0) return OperationResult<VoiceAssetDto>.Failure("voice_asset.invalid_name", "音色名称不能生成有效 ID。");
        var style = NormalizeStyle(command.Style);
        var voiceId = $"{baseName}_{style}";
        if (await store.GetAsync(VoiceAssetDomain, voiceId, cancellationToken) is not null)
            return OperationResult<VoiceAssetDto>.Failure("voice_asset.exists", $"音色已存在：{voiceId}");
        var value = new VoiceAssetDto(voiceId, string.IsNullOrWhiteSpace(command.DisplayName) ? voiceId : command.DisplayName.Trim(),
            Path.GetFullPath(command.SourceFolderPath), true, DateTimeOffset.Now);
        await store.UpsertAsync(VoiceAssetDomain, voiceId, JsonSerializer.Serialize(value), value.UpdatedAt, cancellationToken);
        return OperationResult<VoiceAssetDto>.Success(value);
    }

    public async Task<OperationResult<string>> HandleAsync(ImportCharacterAvatarCommand command, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(command.SourcePath)) return OperationResult<string>.Failure("character.avatar_missing", "头像文件不存在。");
        var extension = Path.GetExtension(command.SourcePath).ToLowerInvariant();
        if (extension is not (".png" or ".jpg" or ".jpeg" or ".gif" or ".bmp" or ".webp"))
            return OperationResult<string>.Failure("character.avatar_type", "头像文件格式不受支持。");
        var directory = paths.Data("characters");
        Directory.CreateDirectory(directory);
        var fileName = Path.GetFileName(command.SourcePath);
        var destination = Path.Combine(directory, fileName);
        if (!Path.GetFullPath(command.SourcePath).Equals(Path.GetFullPath(destination), StringComparison.OrdinalIgnoreCase))
        {
            var name = Path.GetFileNameWithoutExtension(fileName);
            var index = 1;
            while (File.Exists(destination)) destination = Path.Combine(directory, $"{name}_{index++}{extension}");
            File.Copy(command.SourcePath, destination, false);
        }
        await Task.CompletedTask;
        return OperationResult<string>.Success(Path.GetFullPath(destination));
    }

    public async Task<IReadOnlyList<RoleVoiceDto>> HandleAsync(ListRoleVoicesQuery query, CancellationToken cancellationToken = default)
        => (await store.ListAsync(RoleVoiceDomain, cancellationToken)).Select(Parse<RoleVoiceDto>)
            .Where(item => item.IsEnabled && item.RoleId.Equals(query.RoleId, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(item => item.IsDefault).ThenBy(item => StyleOrder(item.Style)).ToArray();

    public async Task<OperationResult> HandleAsync(SetRoleVoicesCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.RoleId)) return OperationResult.Failure("character.invalid_role", "角色 ID 不能为空。");
        var assets = (await HandleAsync(new ListVoiceAssetsQuery(), cancellationToken)).Select(item => item.VoiceId).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (command.Voices.Any(item => !assets.Contains(item.VoiceId))) return OperationResult.Failure("character.voice_missing", "角色绑定了不存在或未启用的音色。");
        var existing = (await store.ListAsync(RoleVoiceDomain, cancellationToken)).Select(json => (Json: json, Value: Parse<RoleVoiceDto>(json)))
            .Where(item => item.Value.RoleId.Equals(command.RoleId, StringComparison.OrdinalIgnoreCase)).ToArray();
        foreach (var item in existing)
        {
            var id = await FindDocumentIdAsync(RoleVoiceDomain, item.Json, cancellationToken);
            if (id is not null) await store.DeleteAsync(RoleVoiceDomain, id, cancellationToken);
        }
        var normalized = command.Voices.Where(item => !string.IsNullOrWhiteSpace(item.VoiceId)).ToArray();
        for (var index = 0; index < normalized.Length; index++)
        {
            var item = normalized[index] with { RoleId = command.RoleId, Style = NormalizeStyle(normalized[index].Style), IsDefault = index == 0, IsEnabled = true, UpdatedAt = DateTimeOffset.Now };
            var id = StableLegacyId("legacy_role_voice_", $"{command.RoleId}:{item.Style}");
            await store.UpsertAsync(RoleVoiceDomain, id, JsonSerializer.Serialize(item), item.UpdatedAt, cancellationToken);
        }
        await events.PublishAsync(new CharacterChangedEvent(EventIdentity.NewId(), DateTimeOffset.Now, command.RoleId, "voices_changed"), cancellationToken);
        return OperationResult.Success();
    }

    public async Task<CharacterObjectBindingDto?> HandleAsync(GetCharacterObjectBindingQuery query, CancellationToken cancellationToken = default)
    {
        var targetKey = NormalizeTargetKey(query.TargetKey);
        if (targetKey.Length == 0) return null;
        foreach (var json in await store.ListAsync(RoleBindingDomain, cancellationToken))
        {
            var item = Parse<CharacterObjectBindingDto>(json);
            if (item.TargetType.Equals("image", StringComparison.OrdinalIgnoreCase) &&
                NormalizeTargetKey(item.TargetKey).Equals(targetKey, StringComparison.OrdinalIgnoreCase)) return item;
        }
        return null;
    }

    public async Task<IReadOnlyList<CharacterObjectBindingDto>> HandleAsync(ListCharacterObjectBindingsQuery query, CancellationToken cancellationToken = default)
        => (await store.ListAsync(RoleBindingDomain, cancellationToken))
            .Select(Parse<CharacterObjectBindingDto>)
            .Where(item => item.RoleId.Equals(query.RoleId.Trim(), StringComparison.OrdinalIgnoreCase))
            .OrderBy(item => item.TargetKey, StringComparer.CurrentCultureIgnoreCase)
            .ToArray();

    public async Task<OperationResult<CharacterObjectBindingDto>> HandleAsync(BindCharacterObjectCommand command, CancellationToken cancellationToken = default)
    {
        var targetKey = NormalizeTargetKey(command.TargetKey);
        if (targetKey.Length == 0) return OperationResult<CharacterObjectBindingDto>.Failure("character.binding_target_empty", "当前没有可绑定的对象。");
        if (string.IsNullOrWhiteSpace(command.RoleId)) return OperationResult<CharacterObjectBindingDto>.Failure("character.invalid_role", "角色 ID 不能为空。");
        if (await characters.GetAsync(command.RoleId.Trim(), cancellationToken) is null)
            return OperationResult<CharacterObjectBindingDto>.Failure("character.not_found", "角色不存在。");
        var now = DateTimeOffset.Now;
        var existing = await HandleAsync(new GetCharacterObjectBindingQuery(targetKey), cancellationToken);
        var value = new CharacterObjectBindingDto("image", targetKey, command.RoleId.Trim(), existing?.CreatedAt ?? now, now);
        if (existing is not null) await DeleteMatchingBindingsAsync(targetKey, cancellationToken);
        await store.UpsertAsync(RoleBindingDomain, BindingId(targetKey), JsonSerializer.Serialize(value), now, cancellationToken);
        return OperationResult<CharacterObjectBindingDto>.Success(value);
    }

    public async Task<OperationResult> HandleAsync(UnbindCharacterObjectCommand command, CancellationToken cancellationToken = default)
    {
        var targetKey = NormalizeTargetKey(command.TargetKey);
        if (targetKey.Length == 0) return OperationResult.Failure("character.binding_target_empty", "当前没有可绑定的对象。");
        await DeleteMatchingBindingsAsync(targetKey, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(ApplyCharacterObjectBindingCommand command, CancellationToken cancellationToken = default)
    {
        var targetKey = NormalizeTargetKey(command.TargetKey);
        if (targetKey.Length == 0) return OperationResult.Failure("character.binding_target_empty", "当前没有可应用绑定的对象。");
        var binding = await HandleAsync(new GetCharacterObjectBindingQuery(targetKey), cancellationToken);
        if (binding is null) return OperationResult.Success();
        if (await characters.GetAsync(binding.RoleId, cancellationToken) is null)
            return OperationResult.Failure("character.not_found", "当前对象绑定的语音角色不存在。");
        var currentRoleId = (await settings.GetAsync(CurrentRoleKey, cancellationToken))?.Value?.Trim() ?? string.Empty;
        if (currentRoleId.Equals(binding.RoleId, StringComparison.OrdinalIgnoreCase)) return OperationResult.Success();
        await settings.SetManyAsync(new Dictionary<string, string> { [CurrentRoleKey] = binding.RoleId }, cancellationToken);
        await events.PublishAsync(new CharacterChangedEvent(
            EventIdentity.NewId(), DateTimeOffset.Now, binding.RoleId, "selected"), cancellationToken);
        return OperationResult.Success();
    }

    private async Task DeleteMatchingBindingsAsync(string targetKey, CancellationToken cancellationToken)
    {
        foreach (var id in await store.ListIdsAsync(RoleBindingDomain, cancellationToken))
        {
            var json = await store.GetAsync(RoleBindingDomain, id, cancellationToken);
            if (json is null) continue;
            var item = Parse<CharacterObjectBindingDto>(json);
            if (item.TargetType.Equals("image", StringComparison.OrdinalIgnoreCase) &&
                NormalizeTargetKey(item.TargetKey).Equals(targetKey, StringComparison.OrdinalIgnoreCase))
                await store.DeleteAsync(RoleBindingDomain, id, cancellationToken);
        }
    }

    private async Task<string?> FindDocumentIdAsync(string domain, string json, CancellationToken cancellationToken)
    {
        foreach (var id in await store.ListIdsAsync(domain, cancellationToken))
            if (string.Equals(await store.GetAsync(domain, id, cancellationToken), json, StringComparison.Ordinal)) return id;
        return null;
    }

    private static T Parse<T>(string json) => JsonSerializer.Deserialize<T>(json, JsonOptions) ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");
    private static string NormalizeStyle(string value) => value.Trim().ToLowerInvariant() is "soft" or "lively" or "close" ? value.Trim().ToLowerInvariant() : "normal";
    private static int StyleOrder(string value) => NormalizeStyle(value) switch { "normal" => 0, "soft" => 1, "lively" => 2, "close" => 3, _ => 4 };
    private static string Sanitize(string value)
    {
        var result = new StringBuilder();
        foreach (var character in value.Trim())
            if (char.IsLetterOrDigit(character) || character is '_' or '-') result.Append(char.ToLowerInvariant(character));
            else if (char.IsWhiteSpace(character)) result.Append('_');
        return result.ToString().Trim('_', '-');
    }
    private static string TrimStyleSuffix(string value)
    {
        foreach (var suffix in new[] { "_normal", "_soft", "_lively", "_close" }) if (value.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) return value[..^suffix.Length];
        return value;
    }
    private static string NormalizeTargetKey(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        try { return Path.GetFullPath(value.Trim()); }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException) { return string.Empty; }
    }
    private static string BindingId(string targetKey) => StableLegacyId("legacy_voice_binding_", targetKey);
    private static string StableLegacyId(string prefix, string semanticKey)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(semanticKey));
        var numericId = BinaryPrimitives.ReadUInt64BigEndian(hash) & long.MaxValue;
        return prefix + numericId.ToString(CultureInfo.InvariantCulture);
    }
}
