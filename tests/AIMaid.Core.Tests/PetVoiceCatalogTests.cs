using AIMaid.Core;

namespace AIMaid.Core.Tests;

[TestClass]
public sealed class PetVoiceCatalogTests
{
    [TestMethod]
    public void Catalog_HasExactlyNineReachableSlots()
    {
        Assert.AreEqual(9, PetVoiceTriggerCatalog.Plans.Count);
        Assert.IsTrue(PetVoiceTriggerCatalog.Contains("startup.welcome", "default"));
        Assert.IsTrue(PetVoiceTriggerCatalog.Contains("click", "face"));
        Assert.IsFalse(PetVoiceTriggerCatalog.Contains("hover.long", "default"));
    }

    [TestMethod]
    public void PeriodCalculator_ProducesContiguousCurrentAndNextPeriods()
    {
        var current = PetVoiceCachePeriodCalculator.Calculate(new DateTimeOffset(2026, 7, 23, 10, 35, 0, TimeSpan.FromHours(8)), 2);
        Assert.AreEqual(current.EndAt, current.NextStartAt);
        Assert.AreEqual(current.NextCacheKey, current.NextStartAt.ToString("yyyyMMddHH"));
        Assert.AreEqual(TimeSpan.FromHours(2), current.EndAt - current.StartAt);
    }
}
