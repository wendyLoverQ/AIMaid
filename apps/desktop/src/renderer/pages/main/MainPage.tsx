import type { UiIconName } from '../../components/ui'
import { Heading, LayoutSlot, Page, PageContent, Pressable, Strong, UiIcon, WindowTitleBar, useToast } from '../../components/ui'
import type { WindowKind } from '../../../shared/windows'
import { bridge } from '../../shared/bridge'

interface WorkbenchEntry {
  title: string
  target: WindowKind
  icon: UiIconName
}

const GROUPS: ReadonlyArray<{ title: string; entries: readonly WorkbenchEntry[] }> = [
  { title: '常用', entries: [
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
    { title: '计时', target: 'timer', icon: 'gauge' },
    { title: '密码库', target: 'vault', icon: 'settings' },
    { title: '快捷脚本', target: 'scripts', icon: 'sparkles' }
  ] }
]
const ENTRIES = GROUPS.flatMap(({ entries }) => entries)

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
        <LayoutSlot as="header" variant="workbench-group__header">
          <Heading level={2}>全部功能</Heading>
        </LayoutSlot>
        <LayoutSlot variant="workbench-grid">
          {ENTRIES.map((entry) => <Pressable appearance="card" key={entry.target} onClick={() => void open(entry.target)}>
            <LayoutSlot as="span" variant="workbench-card__icon"><UiIcon name={entry.icon} /></LayoutSlot>
            <LayoutSlot as="span" variant="workbench-card__copy"><Strong>{entry.title}</Strong></LayoutSlot>
          </Pressable>)}
        </LayoutSlot>
      </LayoutSlot>
    </PageContent>
  </Page>
}
