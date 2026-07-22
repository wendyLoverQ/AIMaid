namespace AIMaid.Contracts.Market;

public sealed record MarketSymbolDto(string Symbol, string BaseAsset, string QuoteAsset, string MarketType);

public sealed record MarketSnapshotDto(
    string Symbol,
    decimal LastPrice,
    decimal PriceChangePercent,
    decimal HighPrice,
    decimal LowPrice,
    decimal QuoteVolume,
    decimal? FundingRate,
    decimal? OpenInterest,
    decimal? BidAskRatio,
    DateTimeOffset UpdatedAt);

public sealed record MarketCandleDto(
    DateTimeOffset OpenTime,
    decimal Open,
    decimal High,
    decimal Low,
    decimal Close,
    decimal Volume);

public sealed record MarketChartSnapshotDto(
    string Symbol,
    string Interval,
    IReadOnlyList<int> EmaPeriods,
    IReadOnlyList<MarketCandleDto> Candles,
    DateTimeOffset UpdatedAt);
