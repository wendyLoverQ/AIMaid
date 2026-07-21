# AIMaid 文件路径统一规则

## 结论

AIMaid 不再根据当前工作目录、仓库目录或是否存在 `release` 文件夹猜测文件位置。

| 类型 | 位置 | 可写 |
|---|---|---|
| 随程序发布的只读资源 | 打包后 `process.resourcesPath/resources`；C# 独立宿主为 `AppContext.BaseDirectory/resources` | 否 |
| 数据库和长期用户数据 | Electron `app.getPath('userData')/data` | 是 |
| 用户配置 | Electron `app.getPath('userData')/config` | 是 |
| 可重建缓存 | `userData/cache`；Chromium Session 单独放系统临时目录 | 是，可清理 |
| 日志 | `userData/logs` | 是，可轮转 |
| 用户选择的媒体/外部工具 | 数据库保存绝对路径 | 由用户选择 |

因此，`release`/安装目录只用于读取随包资源，不存数据库、用户配置、日志或缓存。开发模式的
资源根固定为 `apps/desktop/resources`，也不向上搜索仓库。

## Electron 与 C# 的统一方式

Electron 主进程启动时统一解析路径，并写入以下环境变量；以后启动真实 C# Core 子进程时直接
继承这些变量：

- `AIMAID_RESOURCE_ROOT`
- `AIMAID_DATA_ROOT`
- `AIMAID_CONFIG_ROOT`
- `AIMAID_CACHE_ROOT`
- `AIMAID_LOG_ROOT`

C# 使用 `ApplicationPaths.FromEnvironment()` 读取同一组根目录；未由 Electron 启动时，采用
操作系统用户目录和可执行文件目录的确定性默认值。所有根目录必须是绝对路径，根目录内路径
禁止使用 `..` 逃逸。

## 代码约束

- 业务代码不得调用 `Directory.GetCurrentDirectory()`、`Environment.CurrentDirectory` 或
  `process.cwd()` 来定位文件。
- `Path.GetFullPath(relativePath)` 不得作为产品路径解析方式；调用方必须先通过
  `ApplicationPaths` 取得绝对路径。
- 数据库、TTS 输出目录、下载目录、文件操作、外部程序和工作目录拒绝相对路径。
- Renderer 不直接拼本机路径；文件选择和资源定位通过 Preload/Main 提供的受控 API。
- 安装目录可能只读，任何写入失败都必须作为真实配置错误报告，不能回退到另一个目录。

## 官方依据

- .NET 的 `AppContext.BaseDirectory` 是宿主可执行文件所在目录，适合定位随程序发布的只读内容。
- Electron 的 `app.getPath('userData')` 用于应用配置/用户数据，`sessionData` 用于 Chromium
  Cookie、网络状态和磁盘缓存；`sessionData` 必须在 `ready` 之前设置。
- Electron 的 `process.resourcesPath` 是打包资源目录。
