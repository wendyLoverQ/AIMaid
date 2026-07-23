# AIMaid 本地资源单份化调整

## 目标

`apps/desktop/resources` 作为资源唯一来源。

本地日常运行的 `release/win-unpacked` 不再保存第二份真实资源文件，而是通过 Windows 目录联接直接使用源资源。

正式独立发布仍然复制完整资源，保证发布包脱离源码目录也能运行。

## 当前问题

1. `electron-builder` 会把 `resources/core`、`resources/live2d`、`resources/ui` 复制到 `release/win-unpacked/resources`。
2. `pack:local` 又会复制 Core 和 Live2D，形成重复占用。
3. 当前 `merge-local-package.mjs` 没有同步 `resources/ui`，源图片更新后，本地 release 可能继续使用旧资源。
4. `release` 只是生成目录，不应手工维护或作为资源来源。

## 修改方案

### 1. 修改 `apps/desktop/scripts/merge-local-package.mjs`

保留现有 `out`、`package.json` 和 `app.asar` 处理逻辑。

删除以下逻辑：

- 复制 `resources/core`
- 复制 `resources/live2d`
- 删除 release 内旧 UI 子目录的逻辑

新增统一方法，将以下三个目录替换为 Windows Junction：

- `release/win-unpacked/resources/core`
  → `apps/desktop/resources/core`
- `release/win-unpacked/resources/live2d`
  → `apps/desktop/resources/live2d`
- `release/win-unpacked/resources/ui`
  → `apps/desktop/resources/ui`

处理步骤：

1. 确认源目录真实存在。
2. 删除 release 中原有目标目录或旧联接。
3. 使用 `fs.promises.symlink(source, target, "junction")` 创建目录联接。
4. 创建失败时直接报错并终止，禁止改回复制方案或静默跳过。
5. 输出三个联接的源路径和目标路径。

不要修改运行时资源解析代码。当前打包程序继续读取：

- `process.resourcesPath/core`
- `process.resourcesPath/live2d`
- `process.resourcesPath/ui`

目录联接必须对这些路径保持透明。

### 2. 正式打包前清理本地联接

正式执行 `npm run pack` 前，必须先删除：

`apps/desktop/release/win-unpacked`

避免 `electron-builder` 在本地联接目录上写入，影响源资源。

可以增加一个很小的清理脚本，并在 `pack` 命令中于构建前调用。

只删除 `release/win-unpacked`，不要删除整个 `release`，避免误删其他正式产物。

### 3. 保持正式发布方式不变

`package.json` 中 `extraResources` 的三个资源项继续保留。

正式 `pack` 生成的目录必须包含真实资源文件，不得使用联接、软链接或依赖源码绝对路径。

## 最终结构

```text
apps/desktop/
├─ resources/                  # 唯一资源来源
│  ├─ core/
│  ├─ live2d/
│  └─ ui/
└─ release/
   └─ win-unpacked/
      └─ resources/
         ├─ core     -> 本地 Junction
         ├─ live2d   -> 本地 Junction
         └─ ui       -> 本地 Junction
```

本地开发时只有一份真实资源。

正式打包时，清理本地联接后，由 `electron-builder` 重新复制出完整独立资源。

## 验收标准

1. 执行 `npm run pack:local` 后，三个目标目录均为 Junction。
2. 启动 `release/win-unpacked/AIMaid.exe` 后，Core、Live2D、图片和 UI 图标正常读取。
3. 修改 `apps/desktop/resources/ui` 或 `resources/live2d` 中的文件后，本地 release 直接读取新文件，不再保留旧副本。
4. 本地 release 中不再存在第二份真实的大型图片资源。
5. 执行正式 `npm run pack` 后，输出目录中是可独立运行的真实资源文件，不依赖项目源码目录。
