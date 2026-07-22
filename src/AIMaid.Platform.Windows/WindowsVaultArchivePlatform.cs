using System.Diagnostics;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

public sealed class WindowsVaultArchivePlatform : IVaultArchivePlatform
{
    public async Task CreateEncrypted7zAsync(string jsonContent, string outputPath, string password, CancellationToken cancellationToken = default)
    {
        if (!Path.IsPathFullyQualified(outputPath)) throw new ArgumentException("导出路径必须是绝对路径。", nameof(outputPath));
        if (string.IsNullOrWhiteSpace(password)) throw new InvalidOperationException("Vault encryption string is empty.");
        var sevenZip = FindSevenZip() ?? throw new FileNotFoundException("7z.exe was not found. Install 7-Zip or add it to PATH before exporting.");
        var tempDirectory = Path.Combine(Path.GetTempPath(), "AI_Maid_Vault_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        try
        {
            var jsonPath = Path.Combine(tempDirectory, "vault_backup.json");
            await File.WriteAllTextAsync(jsonPath, jsonContent, cancellationToken);
            if (File.Exists(outputPath)) File.Delete(outputPath);
            var startInfo = new ProcessStartInfo
            {
                FileName = sevenZip,
                WorkingDirectory = tempDirectory,
                UseShellExecute = false,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };
            foreach (var argument in new[] { "a", "-t7z", "-mhe=on", "-p" + password, outputPath, jsonPath }) startInfo.ArgumentList.Add(argument);
            using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start 7-Zip.");
            var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
            var error = await process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            if (process.ExitCode != 0) throw new InvalidOperationException("7-Zip export failed: " + (string.IsNullOrWhiteSpace(error) ? output : error));
        }
        finally
        {
            try { Directory.Delete(tempDirectory, true); } catch { }
        }
    }

    private static string? FindSevenZip()
    {
        var candidates = new[] { "7z.exe", "7za.exe", "7zz.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "7-Zip", "7z.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "7-Zip", "7z.exe") };
        foreach (var candidate in candidates)
        {
            if (Path.IsPathFullyQualified(candidate)) { if (File.Exists(candidate)) return candidate; continue; }
            foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                var path = Path.Combine(directory, candidate);
                if (File.Exists(path)) return path;
            }
        }
        return null;
    }
}
