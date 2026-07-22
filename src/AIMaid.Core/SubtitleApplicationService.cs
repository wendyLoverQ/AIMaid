using AIMaid.Contracts;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class SubtitleApplicationService :
    IQueryHandler<ListSubtitlesQuery, IReadOnlyList<SubtitleItemDto>>,
    ICommandHandler<ImportSubtitleCommand, OperationResult<SubtitleItemDto>>,
    ICommandHandler<ImportSubtitleFolderCommand, OperationResult<int>>,
    ICommandHandler<DeleteSubtitleCommand, OperationResult>
{
    private static readonly HashSet<string> SubtitleExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".srt", ".ass", ".ssa", ".vtt"
    };

    private readonly string subtitleDirectory;

    public SubtitleApplicationService(ApplicationPaths paths)
    {
        subtitleDirectory = paths.Data(Path.Combine("VideoLibrary", "Subtitles"));
        Directory.CreateDirectory(subtitleDirectory);
    }

    public Task<IReadOnlyList<SubtitleItemDto>> HandleAsync(ListSubtitlesQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<SubtitleItemDto> items = Directory.EnumerateFiles(subtitleDirectory, "*.*", SearchOption.TopDirectoryOnly)
            .Where(IsSubtitleFile)
            .OrderBy(Path.GetFileName, StringComparer.CurrentCultureIgnoreCase)
            .Select(path => new SubtitleItemDto(Path.GetFileName(path), path))
            .ToArray();
        return Task.FromResult(items);
    }

    public Task<OperationResult<SubtitleItemDto>> HandleAsync(ImportSubtitleCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!File.Exists(command.SourcePath))
            return Task.FromResult(OperationResult<SubtitleItemDto>.Failure("subtitle.source_missing", "字幕文件不存在。"));
        if (!IsSubtitleFile(command.SourcePath))
            return Task.FromResult(OperationResult<SubtitleItemDto>.Failure("subtitle.unsupported", "仅支持 srt、ass、ssa、vtt 字幕文件。"));

        var target = CreateUniqueTarget(Path.GetFileName(command.SourcePath));
        File.Copy(command.SourcePath, target, false);
        return Task.FromResult(OperationResult<SubtitleItemDto>.Success(new SubtitleItemDto(Path.GetFileName(target), target)));
    }

    public async Task<OperationResult<int>> HandleAsync(ImportSubtitleFolderCommand command, CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(command.FolderPath))
            return OperationResult<int>.Failure("subtitle.folder_missing", "字幕文件夹不存在。");

        var count = 0;
        foreach (var path in Directory.EnumerateFiles(command.FolderPath, "*.*", SearchOption.AllDirectories).Where(IsSubtitleFile))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var result = await HandleAsync(new ImportSubtitleCommand(path), cancellationToken);
            if (result.Succeeded) count++;
        }
        return OperationResult<int>.Success(count);
    }

    public Task<OperationResult> HandleAsync(DeleteSubtitleCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var fullPath = Path.GetFullPath(command.Path);
        var rootPrefix = Path.GetFullPath(subtitleDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
            return Task.FromResult(OperationResult.Failure("subtitle.path_outside_library", "只能删除字幕资源目录内的文件。"));
        if (File.Exists(fullPath)) File.Delete(fullPath);
        return Task.FromResult(OperationResult.Success());
    }

    private string CreateUniqueTarget(string fileName)
    {
        var extension = Path.GetExtension(fileName);
        var baseName = Path.GetFileNameWithoutExtension(fileName);
        var target = Path.Combine(subtitleDirectory, fileName);
        var index = 1;
        while (File.Exists(target)) target = Path.Combine(subtitleDirectory, $"{baseName}-{index++}{extension}");
        return target;
    }

    private static bool IsSubtitleFile(string path) => SubtitleExtensions.Contains(Path.GetExtension(path));
}
