using AIMaid.Core;

namespace AIMaid.Infrastructure;

public sealed class LocalFileManager : IFileManager
{
    public Task MoveAsync(string sourcePath, string destinationPath, bool overwrite, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireAbsolute(sourcePath, nameof(sourcePath));
        RequireAbsolute(destinationPath, nameof(destinationPath));
        var source = Path.GetFullPath(sourcePath);
        var destination = Path.GetFullPath(destinationPath);
        if (!File.Exists(source)) throw new FileNotFoundException("源文件不存在。", source);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.Move(source, destination, overwrite);
        return Task.CompletedTask;
    }

    public Task DeleteAsync(string path, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireAbsolute(path, nameof(path));
        var fullPath = Path.GetFullPath(path);
        if (!File.Exists(fullPath)) throw new FileNotFoundException("待删除文件不存在。", fullPath);
        File.Delete(fullPath);
        return Task.CompletedTask;
    }

    private static void RequireAbsolute(string path, string parameterName)
    {
        if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("文件操作路径必须是绝对路径。", parameterName);
    }
}
