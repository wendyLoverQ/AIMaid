namespace AIMaid.LegacyMigration;

public sealed record MigrationReport(
    string SourcePath,
    string DestinationPath,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    int SourceTableCount,
    long MigratedRows,
    long DroppedRows,
    IReadOnlyList<TableMigrationResult> Tables,
    IReadOnlyList<string> Warnings);

public sealed record TableMigrationResult(
    string SourceTable,
    long SourceRows,
    string Disposition,
    string? Target,
    long MigratedRows,
    IReadOnlyList<string> DroppedFields,
    string Reason);
