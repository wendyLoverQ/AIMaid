import type { UiIconName } from '../../components/ui'
import { Heading, LayoutSlot, Page, PageContent, Pressable, Strong, Text, UiIcon, WindowTitleBar, useToast } from '../../components/ui'
import type { WindowKind } from '../../../shared/windows'
import { bridge } from '../../shared/bridge'

interface WorkbenchEntry {
  title: string
  target: WindowKind
  icon: UiIconName
}

const GROUPS: ReadonlyArray<{ title: string; entries: readonly WorkbenchEntry[] }> = [
  { title: '对话与安排', entries: [
    { title: '角色对话中心', target: 'voice-conversation', icon: 'message' },
    { title: '提醒事项', target: 'reminders', icon: 'clock' },
    { title: '记事本', target: 'notebook', icon: 'layers' }
  ] },
  { title: '媒体', entries: [
    { title: '视频库', target: 'video', icon: 'image' },
    { title: '远程视频中心', target: 'remote-video', icon: 'folder' }
  ] },
  { title: '工具', entries: [
    { title: 'BTC', target: 'bitcoin', icon: 'activity' },
    { title: '计时器', target: 'timer', icon: 'gauge' },
    { title: '密码库', target: 'vault', icon: 'settings' },
    { title: '快捷脚本', target: 'scripts', icon: 'sparkles' }
  ] }
]
export function MainPage(): React.JSX.Element {
  const { show } = useToast()
  const open = async (target: WindowKind): Promise<void> => {
    try {
      const opened = await bridge.window.open(target)
      if (!opened.success) {
        show(opened.error?.message ?? '窗口打开失败，请稍后重试。', 'error')
        return
      }
      const closed = await bridge.window.close()
      if (!closed.success) show(closed.error?.message ?? '工作台关闭失败。', 'error')
    } catch (reason) {
      show(reason instanceof Error ? reason.message : '窗口打开失败，请稍后重试。', 'error')
    }
  }
  return <Page>
    <WindowTitleBar title="工作台" />
    <PageContent>
      <LayoutSlot as="section" variant="workbench-sections" aria-label="全部功能">
        <LayoutSlot as="header" variant="workbench-page-header">
          <Heading level={1}>AIMaid 工作台</Heading>
          <Strong>全部功能</Strong>
          <Text tone="secondary" size="sm">从这里打开 AIMaid 的各项工作空间。</Text>
        </LayoutSlot>
        {GROUPS.map((group) => <LayoutSlot as="section" variant={group.entries.length === 2 ? 'workbench-group workbench-group--2' : group.entries.length === 3 ? 'workbench-group workbench-group--3' : 'workbench-group workbench-group--4'} key={group.title}>
          <LayoutSlot as="header" variant="workbench-group__header"><Heading level={2}>{group.title}</Heading></LayoutSlot>
          <LayoutSlot variant={group.entries.length === 2 ? 'workbench-grid workbench-grid--2' : group.entries.length === 3 ? 'workbench-grid workbench-grid--3' : 'workbench-grid workbench-grid--4'}>
            {group.entries.map((entry) => <Pressable appearance="card" key={entry.target} onClick={() => void open(entry.target)}>
              <LayoutSlot as="span" variant="workbench-card__icon"><UiIcon name={entry.icon} /></LayoutSlot>
              <LayoutSlot as="span" variant="workbench-card__copy"><Strong>{entry.title}</Strong></LayoutSlot>
            </Pressable>)}
          </LayoutSlot>
        </LayoutSlot>)}
      </LayoutSlot>
    </PageContent>
  </Page>
}
