using AIMaid.Contracts.Domains;
using AIMaid.Core;

namespace AIMaid.CoreHost.Runtime;

public sealed class UnconfiguredRemoteMediaResolver : IRemoteMediaResolver
{
    public Task<string> ResolveAsync(string url, RemoteSiteDto? site, CancellationToken cancellationToken = default)
        => throw new InvalidOperationException("远程媒体解析器尚未配置。请先完成 yt-dlp Core 接入。");
}
