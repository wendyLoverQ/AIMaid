using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using AIMaid.Contracts.Domains;
using AIMaid.Contracts.Market;
using AIMaid.Core;

namespace AIMaid.CoreHost.Runtime;

public sealed class BinanceMarketApplicationService(IDomainDocumentStore store, ISettingsStore settings) : IDisposable
{
    private const string ProviderSettingKey = "crypto_market_provider_config";
    private static readonly Uri SpotBase = new("https://data-api.binance.vision/");
    private static readonly Uri FuturesBase = new("https://fapi.binance.com/");
    private static readonly Uri LiquidationStream = new("wss://fstream.binance.com/market/ws/!forceOrder@arr");
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(12) };
    private readonly CancellationTokenSource streamShutdown = new();
    private Task? streamTask;

    public void StartLiquidationStream()
        => streamTask ??= Task.Run(() => RunLiquidationStreamAsync(streamShutdown.Token));

    public async Task<IReadOnlyList<MarketSymbolDto>> ListSymbolsAsync(CancellationToken cancellationToken)
    {
        var provider = await GetProviderAsync(cancellationToken);
        using var json = provider is null
            ? await GetJsonAsync(new Uri(SpotBase, "api/v3/exchangeInfo"), cancellationToken)
            : await GetProviderJsonAsync(provider, "api/crypto-market/symbols?exchange=binance&quote=USDT&limit=2000", cancellationToken);
        var root = UnwrapData(json.RootElement);
        var symbols = provider is null && root.TryGetProperty("symbols", out var directSymbols) ? directSymbols : root;
        if (symbols.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("Binance 币种目录响应无效。");
        return symbols.EnumerateArray()
            .Where(item => provider is not null || ReadString(item, "status") == "TRADING" && ReadString(item, "quoteAsset") == "USDT")
            .Select(item => new MarketSymbolDto(ReadString(item, "symbol").Replace("/", string.Empty, StringComparison.Ordinal), ReadString(item, "baseAsset"), "USDT", "spot"))
            .Where(item => item.Symbol.Length > 0)
            .OrderBy(item => item.Symbol, StringComparer.Ordinal)
            .ToArray();
    }

    public async Task<MarketSnapshotDto> GetSnapshotAsync(string rawSymbol, CancellationToken cancellationToken)
    {
        var symbol = NormalizeSymbol(rawSymbol);
        var provider = await GetProviderAsync(cancellationToken);
        using var ticker = provider is null
            ? await GetJsonAsync(new Uri(SpotBase, $"api/v3/ticker/24hr?symbol={Uri.EscapeDataString(symbol)}"), cancellationToken)
            : await GetProviderJsonAsync(provider, $"api/crypto-market/ticker?exchange=binance&symbol={Uri.EscapeDataString(ToUnifiedSymbol(symbol))}", cancellationToken);
        var tickerRoot = UnwrapData(ticker.RootElement);
        var snapshot = new MarketSnapshotDto(
            symbol,
            ReadFirstDecimal(tickerRoot, "lastPrice", "last", "close"),
            ReadFirstDecimal(tickerRoot, "priceChangePercent", "percentage"),
            ReadFirstDecimal(tickerRoot, "highPrice", "high"),
            ReadFirstDecimal(tickerRoot, "lowPrice", "low"),
            ReadFirstDecimal(tickerRoot, "quoteVolume"),
            await TryReadMetricAsync($"fapi/v1/premiumIndex?symbol={Uri.EscapeDataString(symbol)}", "lastFundingRate", cancellationToken),
            await TryReadMetricAsync($"fapi/v1/openInterest?symbol={Uri.EscapeDataString(symbol)}", "openInterest", cancellationToken),
            await TryReadDepthRatioAsync(symbol, cancellationToken),
            DateTimeOffset.Now);
        await store.UpsertAsync("market_snapshot", symbol, JsonSerializer.Serialize(snapshot), snapshot.UpdatedAt, cancellationToken);
        return snapshot;
    }

    public async Task<MarketChartSnapshotDto> GetChartAsync(string rawSymbol, string rawInterval, IReadOnlyList<int> emaPeriods, CancellationToken cancellationToken)
    {
        var symbol = NormalizeSymbol(rawSymbol);
        var interval = NormalizeInterval(rawInterval);
        var provider = await GetProviderAsync(cancellationToken);
        using var json = provider is null
            ? await GetJsonAsync(new Uri(SpotBase, $"api/v3/klines?symbol={Uri.EscapeDataString(symbol)}&interval={interval}&limit=240"), cancellationToken)
            : await GetProviderJsonAsync(provider, $"api/crypto-market/klines?exchange=binance&symbol={Uri.EscapeDataString(ToUnifiedSymbol(symbol))}&interval={interval}&limit=240", cancellationToken);
        var root = UnwrapData(json.RootElement);
        if (root.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Binance K 线响应无效。");
        var candles = root.EnumerateArray().Select(ReadCandle).ToArray();
        var result = new MarketChartSnapshotDto(symbol, interval, emaPeriods.Where(value => value is > 0 and <= 500).Distinct().ToArray(), candles, DateTimeOffset.Now);
        await store.UpsertAsync("market_chart_snapshot", $"{symbol}:{interval}", JsonSerializer.Serialize(result), result.UpdatedAt, cancellationToken);
        return result;
    }

    private async Task<decimal?> TryReadMetricAsync(string relativeUrl, string property, CancellationToken cancellationToken)
    {
        try
        {
            using var json = await GetJsonAsync(new Uri(FuturesBase, relativeUrl), cancellationToken);
            return ReadDecimal(json.RootElement, property);
        }
        catch (HttpRequestException) { return null; }
    }

    private async Task<decimal?> TryReadDepthRatioAsync(string symbol, CancellationToken cancellationToken)
    {
        try
        {
            using var json = await GetJsonAsync(new Uri(FuturesBase, $"fapi/v1/depth?symbol={Uri.EscapeDataString(symbol)}&limit=20"), cancellationToken);
            var bids = SumQuantity(json.RootElement, "bids");
            var asks = SumQuantity(json.RootElement, "asks");
            return asks == 0 ? null : bids / asks;
        }
        catch (HttpRequestException) { return null; }
    }

    private async Task<JsonDocument> GetJsonAsync(Uri uri, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    }

    private async Task<ProviderConfiguration?> GetProviderAsync(CancellationToken cancellationToken)
    {
        var value = (await settings.GetAsync(ProviderSettingKey, cancellationToken))?.Value;
        if (string.IsNullOrWhiteSpace(value)) return null;
        var configuration = JsonSerializer.Deserialize<ProviderConfiguration>(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        if (configuration is null || !configuration.IsEnabled) return null;
        if (!Uri.TryCreate(configuration.ServiceUrl.TrimEnd('/') + '/', UriKind.Absolute, out var baseUri) || baseUri.Scheme is not ("http" or "https"))
            throw new InvalidDataException("AI Provider 行情服务地址无效。");
        return configuration with { ServiceUrl = baseUri.ToString(), TimeoutSeconds = Math.Clamp(configuration.TimeoutSeconds, 1, 120) };
    }

    private async Task<JsonDocument> GetProviderJsonAsync(ProviderConfiguration provider, string relativeUrl, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(provider.TimeoutSeconds));
        return await GetJsonAsync(new Uri(new Uri(provider.ServiceUrl), relativeUrl), timeout.Token);
    }

    private async Task RunLiquidationStreamAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using var socket = new ClientWebSocket();
                socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                await socket.ConnectAsync(LiquidationStream, cancellationToken);
                await ReceiveLiquidationsAsync(socket, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
            catch (Exception)
            {
                try { await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken); }
                catch (OperationCanceledException) { }
            }
        }
    }

    private async Task ReceiveLiquidationsAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close) return;
            if (result.MessageType != WebSocketMessageType.Text) continue;
            message.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;
            var json = Encoding.UTF8.GetString(message.GetBuffer(), 0, checked((int)message.Length));
            message.SetLength(0);
            await PersistLiquidationAsync(json, cancellationToken);
        }
    }

    private async Task PersistLiquidationAsync(string json, CancellationToken cancellationToken)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (ReadString(root, "e") != "forceOrder" || !root.TryGetProperty("o", out var order)) return;
        var symbol = ReadString(order, "s");
        var side = ReadString(order, "S");
        var quantity = ReadDecimal(order, "z");
        if (quantity == 0) quantity = ReadDecimal(order, "q");
        var price = ReadDecimal(order, "ap");
        if (price == 0) price = ReadDecimal(order, "p");
        var timestamp = order.TryGetProperty("T", out var tradeTime) && tradeTime.TryGetInt64(out var milliseconds)
            ? DateTimeOffset.FromUnixTimeMilliseconds(milliseconds)
            : DateTimeOffset.Now;
        var eventId = $"binance-liquidation:{symbol}:{timestamp.ToUnixTimeMilliseconds()}:{side}";
        var marketEvent = new MarketEventDto(
            eventId, "liquidation", "binance-futures", "binance", symbol,
            side, string.Empty, quantity, price, eventId, json, timestamp);
        await store.UpsertAsync("market_event", eventId, JsonSerializer.Serialize(marketEvent), timestamp, cancellationToken);
    }

    private static MarketCandleDto ReadCandle(JsonElement item)
    {
        if (item.ValueKind == JsonValueKind.Object)
        {
            var rawTimestamp = ReadFirstDecimal(item, "timestamp", "time");
            return new MarketCandleDto(
                DateTimeOffset.FromUnixTimeMilliseconds(decimal.ToInt64(rawTimestamp)),
                ReadFirstDecimal(item, "open"), ReadFirstDecimal(item, "high"), ReadFirstDecimal(item, "low"),
                ReadFirstDecimal(item, "close"), ReadFirstDecimal(item, "volume"));
        }
        if (item.ValueKind != JsonValueKind.Array || item.GetArrayLength() < 6) throw new InvalidDataException("Binance K 线条目无效。");
        return new MarketCandleDto(
            DateTimeOffset.FromUnixTimeMilliseconds(item[0].GetInt64()),
            ParseDecimal(item[1].GetString()), ParseDecimal(item[2].GetString()), ParseDecimal(item[3].GetString()),
            ParseDecimal(item[4].GetString()), ParseDecimal(item[5].GetString()));
    }

    private static decimal SumQuantity(JsonElement root, string property)
        => root.TryGetProperty(property, out var rows) && rows.ValueKind == JsonValueKind.Array
            ? rows.EnumerateArray().Where(row => row.ValueKind == JsonValueKind.Array && row.GetArrayLength() >= 2).Sum(row => ParseDecimal(row[1].GetString()))
            : 0;

    private static string NormalizeSymbol(string value)
    {
        var symbol = value.Trim().ToUpperInvariant();
        if (!symbol.EndsWith("USDT", StringComparison.Ordinal)) symbol += "USDT";
        if (symbol.Length is < 5 or > 24 || symbol.Any(character => !char.IsAsciiLetterOrDigit(character)))
            throw new ArgumentException("行情代码无效。");
        return symbol;
    }

    private static string NormalizeInterval(string value) => value.Trim() switch
    {
        "1m" or "5m" or "15m" or "1h" or "4h" or "1d" or "1w" => value.Trim(),
        _ => throw new ArgumentException("K 线周期无效。")
    };

    private static string ReadString(JsonElement root, string property)
        => root.TryGetProperty(property, out var value) ? value.GetString() ?? string.Empty : string.Empty;

    private static decimal ReadDecimal(JsonElement root, string property)
        => root.TryGetProperty(property, out var value) ? ParseDecimalElement(value) : 0;

    private static decimal ReadFirstDecimal(JsonElement root, params string[] properties)
    {
        foreach (var property in properties)
            if (root.TryGetProperty(property, out var value)) return ParseDecimalElement(value);
        return 0;
    }

    private static decimal ParseDecimalElement(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Number when value.TryGetDecimal(out var number) => number,
        JsonValueKind.String => ParseDecimal(value.GetString()),
        _ => 0
    };

    private static JsonElement UnwrapData(JsonElement root)
        => root.ValueKind == JsonValueKind.Object && root.TryGetProperty("data", out var data) ? data : root;

    private static string ToUnifiedSymbol(string symbol)
        => symbol.EndsWith("USDT", StringComparison.Ordinal) ? $"{symbol[..^4]}/USDT" : symbol;

    private static decimal ParseDecimal(string? value)
        => decimal.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var result) ? result : 0;

    private sealed record ProviderConfiguration(bool IsEnabled, string ServiceUrl, int TimeoutSeconds);

    public void Dispose()
    {
        streamShutdown.Cancel();
        try { streamTask?.Wait(TimeSpan.FromSeconds(2)); } catch (AggregateException) { }
        streamShutdown.Dispose();
        http.Dispose();
    }
}
