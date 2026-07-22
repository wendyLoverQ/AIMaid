# AIMaid 统一 UI 组件使用说明

React 业务页面只能从 `apps/desktop/src/renderer/components/ui.ts` 导入可见控件。页面负责文案、数据、业务事件和布局组合，不负责重新定义控件颜色、高度、圆角、Focus、Loading 或 Disabled 状态。

## 基础规则

- 配色、字号、间距、圆角、阴影、动画、层级、控件与图标尺寸统一定义在 `theme/tokens.css`。
- 项目保留配色主题选择，但不提供深色模式、浅色模式或跟随系统模式。
- Button 默认 `md`（36px），普通文案自动撑宽且不会在 Flex 中被压缩；提交中使用 `loading`，组件会禁用点击并保持宽度。
- 表单优先使用 `FormField` 组合 Label、说明和错误信息；错误状态不能只依赖颜色。
- IconButton 必须提供 `label`，需要提示时提供 `tooltip`。
- Dialog、Drawer 和 Toast 统一渲染到 `#aimaid-ui-portal-root`。
- 页面禁止裸 `button`、`input`、`select`、`textarea`、`dialog`、`table`，禁止 `div onClick` 模拟按钮。

## 常用示例

```tsx
<FormField label="角色名称" required error={nameError} htmlFor="role-name">
  <Input id="role-name" value={name} onChange={handleNameChange} />
</FormField>

<Button variant="primary" loading={saving} disabled={!canSave} onClick={save}>
  保存设置
</Button>

<ConfirmDialog
  open={deleting}
  title="删除角色？"
  description="删除后无法恢复。"
  confirmText="删除"
  confirmVariant="danger"
  loading={submitting}
  onConfirm={remove}
  onCancel={close}
/>
```

开发环境通过 `ui-showcase` 窗口检查全部组件、尺寸、状态、长文本和复合控件。新增通用交互时先扩展统一组件及 Showcase，再在业务页面使用。

## 迁移结果

- `src/renderer/pages` 与 `src/renderer/features` 已禁止裸可见 DOM 控件、页面 CSS、内联视觉样式和自制菜单。
- 笔记本、角色对话中心和专业行情图已从旧 iframe 页面迁移为 React 组件页面。
- 已删除旧 `ActionButton`、`StatusPill`、`WebFrame`、`LegacyWebUiPage` 以及 `components/page-styles` 下的页面控件覆盖文件。
- 正式页面均已迁移；当前尚未迁移页面：无。
- 抖音登录中的 `ExternalWebview` 是受限的外部站点登录容器，不承载 AIMaid 自身业务 UI。
