using System.Security.Cryptography;
using System.Runtime.Versioning;
using System.Text;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

[SupportedOSPlatform("windows")]
public static class WindowsSecretProtectionKeyStore
{
    private const string ProtectedKeyFileName = "secret-protection-key.dpapi";
    private const string LegacyPlaintextKeyFileName = "vault.key";
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("AIMaid.SecretProtection.v1");

    public static string LoadOrCreate(ApplicationPaths paths)
    {
        ArgumentNullException.ThrowIfNull(paths);
        var protectedKeyPath = paths.Data(ProtectedKeyFileName);
        if (File.Exists(protectedKeyPath))
        {
            var protectedKey = File.ReadAllBytes(protectedKeyPath);
            var key = ProtectedData.Unprotect(protectedKey, Entropy, DataProtectionScope.CurrentUser);
            try { return ValidateAndEncode(key, protectedKeyPath); }
            finally { CryptographicOperations.ZeroMemory(key); }
        }

        var legacyKeyPath = paths.Config(LegacyPlaintextKeyFileName);
        if (File.Exists(legacyKeyPath))
        {
            var keyText = File.ReadAllText(legacyKeyPath).Trim();
            var key = DecodeAndValidate(keyText, legacyKeyPath);
            try
            {
                PersistProtectedKey(protectedKeyPath, key);
                return keyText;
            }
            finally { CryptographicOperations.ZeroMemory(key); }
        }

        var generated = RandomNumberGenerator.GetBytes(32);
        try
        {
            PersistProtectedKey(protectedKeyPath, generated);
            return Convert.ToBase64String(generated);
        }
        finally { CryptographicOperations.ZeroMemory(generated); }
    }

    private static void PersistProtectedKey(string path, byte[] key)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? throw new InvalidOperationException("密码库密钥目录无效。"));
        var protectedKey = ProtectedData.Protect(key, Entropy, DataProtectionScope.CurrentUser);
        var temporaryPath = path + $".partial-{Guid.NewGuid():N}";
        try
        {
            File.WriteAllBytes(temporaryPath, protectedKey);
            File.Move(temporaryPath, path, false);
            File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.Hidden);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(protectedKey);
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    private static byte[] DecodeAndValidate(string keyText, string source)
    {
        byte[] key;
        try { key = Convert.FromBase64String(keyText); }
        catch (FormatException exception) { throw new InvalidDataException($"密码库密钥不是有效 Base64：{source}", exception); }
        if (key.Length is 16 or 24 or 32) return key;
        CryptographicOperations.ZeroMemory(key);
        throw new InvalidDataException($"密码库密钥长度无效：{source}");
    }

    private static string ValidateAndEncode(byte[] key, string source)
    {
        if (key.Length is not (16 or 24 or 32)) throw new InvalidDataException($"DPAPI 密钥长度无效：{source}");
        return Convert.ToBase64String(key);
    }
}
