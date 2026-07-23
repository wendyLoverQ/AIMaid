using System.Globalization;

namespace AIMaid.Core;

public sealed record PetVoiceCachePeriod(string CacheKey, DateTimeOffset StartAt, DateTimeOffset EndAt,
    string NextCacheKey, DateTimeOffset NextStartAt, DateTimeOffset NextEndAt);

public static class PetVoiceCachePeriodCalculator
{
    public static PetVoiceCachePeriod Calculate(DateTimeOffset now, int hours)
    {
        if (hours is not (1 or 2 or 4 or 8 or 16)) throw new ArgumentOutOfRangeException(nameof(hours));
        var local = now.ToLocalTime();
        var epoch = new DateTimeOffset(2000, 1, 1, 0, 0, 0, local.Offset);
        var elapsed = (long)Math.Floor((local - epoch).TotalHours);
        var start = epoch.AddHours(elapsed / hours * hours);
        var end = start.AddHours(hours);
        return new PetVoiceCachePeriod(Key(start), start, end, Key(end), end, end.AddHours(hours));
    }

    private static string Key(DateTimeOffset start) => start.ToString("yyyyMMddHH", CultureInfo.InvariantCulture);
}
