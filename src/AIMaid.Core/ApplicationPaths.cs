namespace AIMaid.Core;

public sealed record ApplicationPaths(
    string ResourceRoot,
    string DataRoot,
    string ConfigRoot,
    string CacheRoot,
    string LogRoot)
{
    public const string ResourceRootEnvironmentVariable = "AIMAID_RESOURCE_ROOT";
    public const string DataRootEnvironmentVariable = "AIMAID_DATA_ROOT";
    public const string ConfigRootEnvironmentVariable = "AIMAID_CONFIG_ROOT";
    public const string CacheRootEnvironmentVariable = "AIMAID_CACHE_ROOT";
    public const string LogRootEnvironmentVariable = "AIMAID_LOG_ROOT";

    public static ApplicationPaths FromEnvironment(string applicationName = "AIMaid")
    {
        var roamingRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), applicationName);
        var localRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), applicationName);
        return Create(
            Environment.GetEnvironmentVariable(ResourceRootEnvironmentVariable) ?? Path.Combine(AppContext.BaseDirectory, "resources"),
            Environment.GetEnvironmentVariable(DataRootEnvironmentVariable) ?? Path.Combine(roamingRoot, "data"),
            Environment.GetEnvironmentVariable(ConfigRootEnvironmentVariable) ?? Path.Combine(roamingRoot, "config"),
            Environment.GetEnvironmentVariable(CacheRootEnvironmentVariable) ?? Path.Combine(localRoot, "cache"),
            Environment.GetEnvironmentVariable(LogRootEnvironmentVariable) ?? Path.Combine(localRoot, "logs"));
    }

    public static ApplicationPaths Create(string resourceRoot, string dataRoot, string configRoot, string cacheRoot, string logRoot)
        => new(Absolute(resourceRoot, nameof(resourceRoot)), Absolute(dataRoot, nameof(dataRoot)),
            Absolute(configRoot, nameof(configRoot)), Absolute(cacheRoot, nameof(cacheRoot)), Absolute(logRoot, nameof(logRoot)));

    public string Resource(string relativePath) => ResolveUnder(ResourceRoot, relativePath);
    public string Data(string relativePath) => ResolveUnder(DataRoot, relativePath);
    public string Config(string relativePath) => ResolveUnder(ConfigRoot, relativePath);
    public string Cache(string relativePath) => ResolveUnder(CacheRoot, relativePath);
    public string Log(string relativePath) => ResolveUnder(LogRoot, relativePath);

    public void EnsureWritableDirectories()
    {
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(ConfigRoot);
        Directory.CreateDirectory(CacheRoot);
        Directory.CreateDirectory(LogRoot);
    }

    private static string Absolute(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value))
            throw new ArgumentException("应用路径必须是绝对路径。", parameterName);
        return Path.GetFullPath(value);
    }

    private static string ResolveUnder(string root, string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathFullyQualified(relativePath))
            throw new ArgumentException("只能传入根目录内的相对路径。", nameof(relativePath));
        var resolved = Path.GetFullPath(Path.Combine(root, relativePath));
        var prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!resolved.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("路径不能逃逸应用根目录。", nameof(relativePath));
        return resolved;
    }
}
