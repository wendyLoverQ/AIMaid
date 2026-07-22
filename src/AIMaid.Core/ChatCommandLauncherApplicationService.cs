using System.Diagnostics;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class ChatCommandLauncherApplicationService(IDomainDocumentStore store) :
    ICommandHandler<SaveChatCommandLauncherCommand, OperationResult<ChatCommandLauncherDto>>,
    ICommandHandler<RunChatCommandLauncherCommand, OperationResult<string>>,
    IQueryHandler<ListChatCommandLaunchersQuery, IReadOnlyList<ChatCommandLauncherDto>>
{
    private const string Domain = "chat_command_launcher";

    public async Task<IReadOnlyList<ChatCommandLauncherDto>> HandleAsync(ListChatCommandLaunchersQuery query, CancellationToken cancellationToken = default)
    {
        var documents = await store.ListAsync(Domain, cancellationToken);
        return documents.Select(x => JsonSerializer.Deserialize<ChatCommandLauncherDto>(x))
            .Where(x => x is not null).Cast<ChatCommandLauncherDto>()
            .OrderBy(x => x.CommandText, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public async Task<OperationResult<ChatCommandLauncherDto>> HandleAsync(SaveChatCommandLauncherCommand command, CancellationToken cancellationToken = default)
    {
        var value = command.Launcher;
        var commandText = value.CommandText.Trim();
        if (!commandText.StartsWith('-') || commandText.Length is < 2 or > 32 || commandText.Any(char.IsWhiteSpace))
            return OperationResult<ChatCommandLauncherDto>.Failure("script.invalid_command", "聊天指令必须以“-”开头、不含空格，且不超过 32 个字符。");
        if (string.IsNullOrWhiteSpace(value.DisplayName) || string.IsNullOrWhiteSpace(value.ExePath))
            return OperationResult<ChatCommandLauncherDto>.Failure("script.required", "显示名称和程序或脚本路径不能为空。");
        var all = await HandleAsync(new ListChatCommandLaunchersQuery(), cancellationToken);
        if (all.Any(x => x.LauncherId != value.LauncherId && x.CommandText.Equals(commandText, StringComparison.OrdinalIgnoreCase)))
            return OperationResult<ChatCommandLauncherDto>.Failure("script.duplicate", $"聊天指令已存在：{commandText}");
        var saved = value with
        {
            LauncherId = string.IsNullOrWhiteSpace(value.LauncherId) ? $"launcher_{Guid.NewGuid():N}" : value.LauncherId,
            CommandText = commandText,
            DisplayName = value.DisplayName.Trim(),
            ExePath = value.ExePath.Trim(),
            Arguments = value.Arguments.Trim(),
            WorkingDirectory = value.WorkingDirectory.Trim(),
            UpdatedAt = DateTimeOffset.Now
        };
        await store.UpsertAsync(Domain, saved.LauncherId, JsonSerializer.Serialize(saved), saved.UpdatedAt, cancellationToken);
        return OperationResult<ChatCommandLauncherDto>.Success(saved);
    }

    public async Task<OperationResult<string>> HandleAsync(RunChatCommandLauncherCommand command, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(Domain, command.LauncherId, cancellationToken);
        var launcher = json is null ? null : JsonSerializer.Deserialize<ChatCommandLauncherDto>(json);
        if (launcher is null) return OperationResult<string>.Failure("script.not_found", "快捷脚本不存在。");
        if (!launcher.Enabled) return OperationResult<string>.Failure("script.disabled", $"快捷脚本已禁用：{launcher.DisplayName}");
        try
        {
            var startInfo = new ProcessStartInfo { FileName = launcher.ExePath, Arguments = launcher.Arguments, UseShellExecute = true };
            if (!string.IsNullOrWhiteSpace(launcher.WorkingDirectory) && Directory.Exists(launcher.WorkingDirectory)) startInfo.WorkingDirectory = launcher.WorkingDirectory;
            Process.Start(startInfo);
            return OperationResult<string>.Success($"已启动：{launcher.DisplayName}");
        }
        catch
        {
            return OperationResult<string>.Failure("script.launch_failed", $"启动失败：{launcher.DisplayName}");
        }
    }
}
