using AIMaid.LegacyMigration;

try
{
    var options = MigrationOptions.Parse(args);
    var report = await new LegacyDatabaseMigrator().MigrateAsync(options);
    Console.WriteLine($"Migration completed: {report.SourceTableCount} source tables, {report.MigratedRows} rows migrated, {report.DroppedRows} rows intentionally dropped.");
    Console.WriteLine($"Destination: {options.DestinationPath}");
    Console.WriteLine($"Report: {options.ReportPath}");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Migration failed: {ex}");
    return 1;
}
