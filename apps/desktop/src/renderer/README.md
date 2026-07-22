# Renderer UI 基础层

Renderer 只负责页面布局、展示、输入和临时 UI 状态。页面统一通过 `shared/bridge.ts` 调用
Preload，不直接访问 `window.aimaid`、IPC、Node.js、数据库或 C# Core。

## Design Token

`theme/tokens.css` 是唯一全局主题入口，当前包含：

- 颜色：画布、表面、悬浮、文本、Accent、成功、警告、错误、边框和焦点。
- 字体：字体族、6 级字号、4 级字重、3 级行高。
- 尺寸：间距、控件高度、标题栏高度、内容宽度和滚动区域高度。
- 外观：圆角、边框、阴影。
- 动效：时长和缓动曲线。
- 层级：基础层、菜单、抽屉、Dialog、Toast 和 Tooltip。

页面 CSS 不得新增一次性颜色、间距或圆角；先选择现有 Token，确有全局语义缺口时再扩展 Token。

## 公共组件清单

| 分类 | 组件 |
|---|---|
| Base | `Button`、`IconButton` |
| Forms | `Input`、`Textarea`、`Select`、`Checkbox`、`Switch` |
| Navigation | `Tabs` |
| Overlays | `Dialog`、`Drawer`、`Tooltip`、`Menu`、`ContextMenu` |
| Feedback | `Toast`、`Loading`、`EmptyState`、`ErrorState`、`OfflineState`、`UnauthorizedState`、`ErrorBoundary` |
| Layout | `ScrollArea`、`WindowTitleBar` |

所有交互组件支持统一禁用状态；Button/IconButton 支持尺寸和加载状态，字段支持错误说明。

## 页面开发规则

1. 页面入口放在 `pages/<page>/`，页面私有组件跟随页面保存。
2. 先组合公共组件，不复制按钮、字段、浮层、滚动区或状态样式。
3. Bridge 只从 `renderer/shared/bridge` 导入；事件订阅必须在 Effect 清理函数中退订。
4. C# Core 保留业务真实状态，Main 保留窗口/进程状态，React 只保留草稿、Tab、筛选和浮层开关。
5. 新页面必须明确 Loading、Empty、Error、Disabled、Offline、Unauthorized 的展示策略；统一使用
   Feedback 组件并提供明确文案，不得静默降级。
6. 普通页面禁止导入 `renderer/live2d`；只有 PetWindow 入口可以动态加载。
7. 只有需要独立系统生命周期和窗口能力时才扩展 Window Registry，普通页面切换留在 React 内部。

`pages/main/MainPage.tsx` 是组件/Bridge 演示页，`pages/demo/DemoWindowPage.tsx` 是独立窗口演示，
两者都不是正式业务页面。
