using System.Text.Encodings.Web;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed record ExportVaultCommand(string OutputPath) : ICommand<OperationResult>;

public sealed class VaultExportApplicationService(
    IDomainDocumentStore store,
    ISecretProtector secrets,
    IVaultArchivePlatform platform) : ICommandHandler<ExportVaultCommand, OperationResult>
{
    public async Task<OperationResult> HandleAsync(ExportVaultCommand command, CancellationToken cancellationToken = default)
    {
        if (!Path.IsPathFullyQualified(command.OutputPath) || !command.OutputPath.EndsWith(".7z", StringComparison.OrdinalIgnoreCase))
            return OperationResult.Failure("vault.export_path", "导出文件必须是绝对路径的 .7z 文件。");
        var protectedPassword = await store.GetAsync("protected_setting", "vault_export_password", cancellationToken);
        var password = Environment.GetEnvironmentVariable("AIMAID_VAULT_EXPORT_PASSWORD");
        if (string.IsNullOrWhiteSpace(password) && protectedPassword is not null) password = secrets.Unprotect(protectedPassword);
        if (string.IsNullOrWhiteSpace(password)) return OperationResult.Failure("vault.export_password", "Vault encryption string is empty.");
        var exported = new List<object>();
        foreach (var json in await store.ListAsync("vault", cancellationToken))
        {
            var item = JsonSerializer.Deserialize<VaultItemDto>(json) ?? throw new InvalidDataException("VaultItemDto JSON 无效。");
            var metadata = ParseObject(item.PublicMetadataJson);
            var protectedSecret = await store.GetAsync("vault_secret", item.ItemId, cancellationToken);
            var secret = protectedSecret is null ? new Dictionary<string, string>() : ParseObject(secrets.Unprotect(protectedSecret));
            exported.Add(new
            {
                item.ItemId, item.ItemType, item.Name, item.Category, item.Account,
                Password = secret.GetValueOrDefault("Password") ?? string.Empty, item.Url, item.Platform,
                ApiKey = secret.GetValueOrDefault("ApiKey") ?? string.Empty,
                Secret = secret.GetValueOrDefault("Secret") ?? string.Empty,
                ChainType = metadata.GetValueOrDefault("ChainType") ?? string.Empty,
                WalletAddress = metadata.GetValueOrDefault("WalletAddress") ?? string.Empty,
                PrivateKey = secret.GetValueOrDefault("PrivateKey") ?? string.Empty,
                Mnemonic = secret.GetValueOrDefault("Mnemonic") ?? string.Empty,
                ServerAddress = metadata.GetValueOrDefault("ServerAddress") ?? string.Empty,
                ServerPort = metadata.GetValueOrDefault("ServerPort") ?? string.Empty,
                Remark = metadata.GetValueOrDefault("Remark") ?? string.Empty,
                item.CreatedAt, item.UpdatedAt
            });
        }
        var output = JsonSerializer.Serialize(exported, new JsonSerializerOptions { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        await platform.CreateEncrypted7zAsync(output, command.OutputPath, password, cancellationToken);
        return OperationResult.Success();
    }

    private static Dictionary<string, string> ParseObject(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new Dictionary<string, string>();
        using var document = JsonDocument.Parse(json);
        return document.RootElement.EnumerateObject().ToDictionary(item => item.Name, item => item.Value.GetString() ?? string.Empty, StringComparer.Ordinal);
    }
}
