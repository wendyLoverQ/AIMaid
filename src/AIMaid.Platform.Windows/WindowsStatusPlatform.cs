using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using AIMaid.Contracts.Status;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

public sealed class WindowsStatusPlatform : IStatusPlatform, IDisposable
{
    private static readonly (string Name, string Host, bool DirectOnly)[] Targets =
    [
        ("ChatGPT", "api.openai.com", false),
        ("Google", "google.com", false),
        ("X", "x.com", false),
        ("抖音", "douyin.com", true),
        ("百度", "baidu.com", true)
    ];

    private readonly object cpuGate = new();
    private readonly SemaphoreSlim gpuGate = new(1, 1);
    private readonly SemaphoreSlim networkGate = new(1, 1);
    private ulong previousIdle;
    private ulong previousKernel;
    private ulong previousUser;
    private bool hasCpuSample;
    private double? cachedGpuPercent;
    private DateTimeOffset gpuRefreshedAt = DateTimeOffset.MinValue;
    private IReadOnlyList<NetworkProbeDto> cachedNetwork = [];
    private string cachedProxy = string.Empty;
    private DateTimeOffset networkRefreshedAt = DateTimeOffset.MinValue;
    private bool disposed;

    public async Task<SystemResourceSnapshotDto> GetResourcesAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var process = Process.GetCurrentProcess();
        var cpu = ReadCpuPercent();
        var gpu = await ReadGpuPercentAsync(cancellationToken);
        return new SystemResourceSnapshotDto(
            Math.Round(cpu, 1),
            gpu.HasValue ? Math.Round(gpu.Value, 1) : null,
            Math.Round(process.WorkingSet64 / 1024d / 1024d, 1),
            Math.Round(GC.GetTotalMemory(false) / 1024d / 1024d, 1));
    }

    public async Task<IReadOnlyList<NetworkProbeDto>> GetNetworkAsync(string? proxyAddress, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var normalizedProxy = NormalizeProxy(proxyAddress);
        if (DateTimeOffset.UtcNow - networkRefreshedAt < TimeSpan.FromSeconds(3) &&
            string.Equals(normalizedProxy, cachedProxy, StringComparison.OrdinalIgnoreCase))
            return cachedNetwork;

        await networkGate.WaitAsync(cancellationToken);
        try
        {
            if (DateTimeOffset.UtcNow - networkRefreshedAt < TimeSpan.FromSeconds(3) &&
                string.Equals(normalizedProxy, cachedProxy, StringComparison.OrdinalIgnoreCase))
                return cachedNetwork;
            cachedNetwork = await Task.WhenAll(Targets.Select(target => ProbeAsync(target, normalizedProxy, cancellationToken)));
            cachedProxy = normalizedProxy;
            networkRefreshedAt = DateTimeOffset.UtcNow;
            return cachedNetwork;
        }
        finally { networkGate.Release(); }
    }

    private double ReadCpuPercent()
    {
        if (!GetSystemTimes(out var idleTime, out var kernelTime, out var userTime))
            throw new InvalidOperationException("无法读取 Windows CPU 时间。");
        var idle = ToUInt64(idleTime);
        var kernel = ToUInt64(kernelTime);
        var user = ToUInt64(userTime);
        lock (cpuGate)
        {
            if (!hasCpuSample)
            {
                previousIdle = idle;
                previousKernel = kernel;
                previousUser = user;
                hasCpuSample = true;
                return 0;
            }
            var idleDelta = idle - previousIdle;
            var totalDelta = kernel - previousKernel + user - previousUser;
            previousIdle = idle;
            previousKernel = kernel;
            previousUser = user;
            return totalDelta == 0 ? 0 : Math.Clamp((totalDelta - idleDelta) * 100d / totalDelta, 0, 100);
        }
    }

    private async Task<double?> ReadGpuPercentAsync(CancellationToken cancellationToken)
    {
        if (DateTimeOffset.UtcNow - gpuRefreshedAt < TimeSpan.FromSeconds(2)) return cachedGpuPercent;
        await gpuGate.WaitAsync(cancellationToken);
        try
        {
            if (DateTimeOffset.UtcNow - gpuRefreshedAt < TimeSpan.FromSeconds(2)) return cachedGpuPercent;
            var start = new ProcessStartInfo
            {
                FileName = "nvidia-smi",
                Arguments = "--query-gpu=utilization.gpu --format=csv,noheader,nounits",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            try
            {
                using var process = Process.Start(start);
                if (process is null) throw new InvalidOperationException("无法启动 nvidia-smi。");
                var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
                await process.WaitForExitAsync(cancellationToken);
                if (process.ExitCode != 0) cachedGpuPercent = null;
                else
                {
                    var values = output.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                        .Select(value => double.Parse(value.Trim(), CultureInfo.InvariantCulture)).ToArray();
                    cachedGpuPercent = values.Length == 0 ? null : values.Average();
                }
            }
            catch (System.ComponentModel.Win32Exception)
            {
                cachedGpuPercent = null;
            }
            gpuRefreshedAt = DateTimeOffset.UtcNow;
            return cachedGpuPercent;
        }
        finally { gpuGate.Release(); }
    }

    private static async Task<NetworkProbeDto> ProbeAsync(
        (string Name, string Host, bool DirectOnly) target,
        string proxyAddress,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        var stopwatch = Stopwatch.StartNew();
        try
        {
            if (proxyAddress.Length > 0 && !target.DirectOnly)
            {
                using var client = new HttpClient(new HttpClientHandler { Proxy = new WebProxy(proxyAddress), UseProxy = true });
                using var request = new HttpRequestMessage(HttpMethod.Get, $"https://{target.Host}");
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            }
            else
            {
                using var client = new TcpClient();
                await client.ConnectAsync(target.Host, 443, timeout.Token);
            }
            return new NetworkProbeDto(target.Name, stopwatch.ElapsedMilliseconds, true);
        }
        catch (Exception exception) when (exception is HttpRequestException or SocketException or OperationCanceledException)
        {
            return new NetworkProbeDto(target.Name, null, false);
        }
    }

    private static string NormalizeProxy(string? value)
    {
        var trimmed = value?.Trim() ?? string.Empty;
        if (trimmed.Length == 0) return string.Empty;
        return trimmed.Contains("://", StringComparison.Ordinal) ? trimmed : $"http://{trimmed}";
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        gpuGate.Dispose();
        networkGate.Dispose();
    }

    private static ulong ToUInt64(FILETIME value) => ((ulong)value.dwHighDateTime << 32) | value.dwLowDateTime;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out FILETIME idleTime, out FILETIME kernelTime, out FILETIME userTime);

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }
}
