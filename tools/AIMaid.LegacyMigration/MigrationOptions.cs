namespace AIMaid.LegacyMigration;

public sealed record MigrationOptions(
    string SourcePath,
    string DestinationPath,
    string ReportPath,
    string TargetSecretKeyBase64,
    string? LegacyVaultKey,
    bool SkipVaultSecrets)
{
    public static MigrationOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            var argument = args[index];
            if (argument == "--skip-vault-secrets") { flags.Add(argument); continue; }
            if (!argument.StartsWith("--", StringComparison.Ordinal) || index + 1 >= args.Length)
                throw new ArgumentException("用法：--source <旧库> --destination <新库> [--report <报告>] [--skip-vault-secrets]");
            values[argument] = args[++index];
        }

        if (!values.TryGetValue("--source", out var source) || !values.TryGetValue("--destination", out var destination))
            throw new ArgumentException("必须提供 --source 和 --destination。");
        source = Path.GetFullPath(source);
        destination = Path.GetFullPath(destination);
        if (string.Equals(source, destination, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("源数据库和目标数据库不能是同一个文件。");
        var report = values.TryGetValue("--report", out var reportPath)
            ? Path.GetFullPath(reportPath)
            : destination + ".migration-report.json";
        var targetKey = Environment.GetEnvironmentVariable("AIMAID_TARGET_SECRET_KEY");
        if (string.IsNullOrWhiteSpace(targetKey))
            throw new InvalidOperationException("必须通过环境变量 AIMAID_TARGET_SECRET_KEY 注入目标库加密密钥。");
        var legacyKey = Environment.GetEnvironmentVariable("AIMAID_LEGACY_VAULT_KEY");
        return new(source, destination, report, targetKey, legacyKey, flags.Contains("--skip-vault-secrets"));
    }
}
