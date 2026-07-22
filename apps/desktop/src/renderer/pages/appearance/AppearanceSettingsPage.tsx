import { useEffect, useRef, useState } from 'react'
import type { AppearanceConfigurationDto } from '../../../shared/business'
import { Badge, ColorPalette, LayoutSlot, Page, PageContent, Pressable, SegmentedControl, SettingRow, SettingsSection, Stack, Strong, Switch, WindowTitleBar, useToast } from '../../components/ui'
import { bridge } from '../../shared/bridge'
import { saveAndApplyAppearance } from './appearance-runtime'

interface ThemeDefinition { id: string; name: string; colors: readonly [string, string, string, string] }
const THEMES: readonly ThemeDefinition[] = [
  theme('fluent_fog', 'Fluent 雾白', '#E9ECEF', '#E1E5E9', '#FFFFFF', '#0F6CBD'),
  theme('macos_mist', 'macOS 云雾', '#E7E9EC', '#DDE1E6', '#FFFFFF', '#1477D4'),
  theme('material_sage', 'Material 鼠尾草', '#E6E8E2', '#DCE2D9', '#FFFFFF', '#4D6355'),
  theme('wechat_soft', '微信柔和', '#E8EBE9', '#DDE3DF', '#FFFFFF', '#07C160'),
  theme('notion_paper', 'Notion 纸页', '#E9E7E2', '#E2DED6', '#FFFFFF', '#6B5C4D'),
  theme('slack_aubergine', 'Slack 茄紫', '#E8E5EA', '#3F2346', '#FFFFFF', '#7B3F86'),
  theme('neutral_soft', '静灰低眩光', '#E7E9EB', '#DDE0E3', '#FFFFFF', '#49727A'),
  theme('cream_paper', '奶油书页', '#E9E3DA', '#DED4C7', '#FFFFFF', '#A05D3E'),
  theme('cool_slate', '冷调石板', '#E2E7EB', '#D4DCE2', '#FFFFFF', '#416E91'),
  theme('anime_sakura_cream', '樱花奶油', '#ECE5E8', '#E2D4DA', '#FFFFFF', '#B65378'),
  theme('anime_mint_soda', '薄荷苏打', '#E1EAE7', '#D2DFDB', '#FFFFFF', '#2F806B'),
  theme('anime_peach_cream', '桃子奶油', '#ECE0DA', '#E0CEC5', '#FFFFFF', '#B35D3D'),
  theme('anime_sky_sailor', '天空水手', '#E0E7EE', '#CFDAE5', '#FFFFFF', '#3F73AE'),
  theme('anime_candy_park', '糖果乐园', '#E7E2EB', '#D8CFE0', '#FFFFFF', '#8E56A8')
]
const DEFAULT_CONFIGURATION: AppearanceConfigurationDto = { themeId: 'neutral_soft', contentBrightness: 'Standard', fontFamily: '', fontScale: 1, cornerRadiusStyle: 'Medium', density: 'Standard', headerStyle: 'Subtle', animationsEnabled: true }

export function AppearanceSettingsPage(): React.JSX.Element {
  const toast = useToast()
  const [configuration, setConfiguration] = useState(DEFAULT_CONFIGURATION)
  const revision = useRef(0)
  useEffect(() => {
    void bridge.core.invoke({ type: 'appearance.get', payload: {} }).then((response) => {
      if (!response.success) throw new Error(response.error?.message ?? '外观设置读取失败。')
      const source = response.payload as AppearanceConfigurationDto
      const loaded = { ...source, themeId: normalizeThemeId(source.themeId) }
      setConfiguration(loaded); saveAndApplyAppearance(loaded, colorsFor(loaded.themeId))
      if (loaded.themeId !== source.themeId) {
        void bridge.core.invoke({ type: 'appearance.save', payload: { configuration: loaded } }).then((migration) => {
          if (!migration.success) throw new Error(migration.error?.message ?? '旧版外观设置迁移失败。')
        }).catch((reason: unknown) => toast.show(messageOf(reason), 'error'))
      }
    }).catch((reason: unknown) => toast.show(reason instanceof Error ? reason.message : String(reason), 'error'))
  }, [toast])
  function update(patch: Partial<AppearanceConfigurationDto>): void {
    const previous = configuration
    const next = { ...configuration, ...patch }
    const currentRevision = ++revision.current
    setConfiguration(next); saveAndApplyAppearance(next, colorsFor(next.themeId))
    void bridge.core.invoke({ type: 'appearance.save', payload: { configuration: next } }).then((response) => {
      if (!response.success) throw new Error(response.error?.message ?? '外观设置保存失败。')
    }).catch((reason: unknown) => {
      if (revision.current === currentRevision) {
        setConfiguration(previous)
        saveAndApplyAppearance(previous, colorsFor(previous.themeId))
      }
      toast.show(messageOf(reason), 'error')
    })
  }
  return <Page>
    <WindowTitleBar title="外观设置" />
    <PageContent><LayoutSlot variant="appearance-content">
      <SettingsSection title="配色方案">
        <LayoutSlot variant="theme-card-grid">{THEMES.map((item) => <ThemeCard key={item.id} item={item} selected={configuration.themeId === item.id} select={() => update({ themeId: item.id })} />)}</LayoutSlot>
        <SettingRow title="内容亮度" control={<SegmentedControl label="内容亮度" value={configuration.contentBrightness} onChange={(contentBrightness) => update({ contentBrightness })} options={[{ value: 'Soft', label: '柔和' }, { value: 'Standard', label: '标准' }, { value: 'Clear', label: '清晰' }]} />} />
      </SettingsSection>
      <SettingsSection title="字体">
        <SettingRow title="字体方案" control={<SegmentedControl label="字体方案" value={configuration.fontFamily} onChange={(fontFamily) => update({ fontFamily })} options={[{ value: '', label: '默认' }, { value: 'Microsoft YaHei UI', label: '微软雅黑' }]} />} />
        <SettingRow title="字号缩放" control={<SegmentedControl label="字号缩放" value={String(configuration.fontScale)} onChange={(fontScale) => update({ fontScale: Number(fontScale) })} options={[{ value: '0.9', label: '90%' }, { value: '1', label: '100%' }, { value: '1.1', label: '110%' }, { value: '1.2', label: '120%' }]} />} />
      </SettingsSection>
      <SettingsSection title="密度与圆角">
        <SettingRow title="圆角风格" control={<SegmentedControl label="圆角风格" value={configuration.cornerRadiusStyle} onChange={(cornerRadiusStyle) => update({ cornerRadiusStyle })} options={[{ value: 'Small', label: '小' }, { value: 'Medium', label: '中' }, { value: 'Large', label: '大' }]} />} />
        <SettingRow title="界面密度" control={<SegmentedControl label="界面密度" value={configuration.density} onChange={(density) => update({ density })} options={[{ value: 'Compact', label: '紧凑' }, { value: 'Standard', label: '标准' }, { value: 'Comfortable', label: '宽松' }]} />} />
      </SettingsSection>
      <SettingsSection title="窗口顶部"><SettingRow title="顶部样式" control={<SegmentedControl label="窗口顶部样式" value={configuration.headerStyle} onChange={(headerStyle) => update({ headerStyle })} options={[{ value: 'None', label: '不显示' }, { value: 'Subtle', label: '柔和' }, { value: 'AccentStrip', label: '主题色顶栏' }, { value: 'Filled', label: '主题色标题栏' }]} />} /></SettingsSection>
      <SettingsSection title="动画"><SettingRow title="界面动画" control={<Switch label={configuration.animationsEnabled ? '已开启' : '已关闭'} checked={configuration.animationsEnabled} onChange={(event) => update({ animationsEnabled: event.target.checked })} />} /></SettingsSection>
    </LayoutSlot></PageContent>
  </Page>
}

function ThemeCard({ item, selected, select }: { item: ThemeDefinition; selected: boolean; select: () => void }): React.JSX.Element {
  return <Pressable appearance="card" selected={selected} aria-current={selected ? 'true' : undefined} onClick={select}>
    <LayoutSlot as="span" variant="theme-card__preview"><ColorPalette colors={item.colors} /><LayoutSlot as="span" variant="theme-card__block" /><LayoutSlot as="span" variant="theme-card__block" /><LayoutSlot as="span" variant="theme-card__block" /></LayoutSlot>
    <Stack gap="xs"><Strong>{item.name}</Strong>{selected ? <Badge tone="accent">当前方案</Badge> : null}</Stack>
  </Pressable>
}
function theme(id: string, name: string, ...colors: [string, string, string, string]): ThemeDefinition { return { id, name, colors } }
function colorsFor(themeId: string): readonly [string, string, string, string] { return THEMES.find((item) => item.id === themeId)?.colors ?? THEMES.find((item) => item.id === DEFAULT_CONFIGURATION.themeId)!.colors }
function normalizeThemeId(themeId: string): string {
  const legacy: Readonly<Record<string, string>> = {
    fluent_fog_light: 'fluent_fog', macos_mist_light: 'macos_mist', material_sage_light: 'material_sage', wechat_soft_light: 'wechat_soft', notion_paper_light: 'notion_paper', slack_aubergine_light: 'slack_aubergine', neutral_soft_light: 'neutral_soft', cream_paper_light: 'cream_paper', cool_slate_light: 'cool_slate', fluent_graphite_dark: 'neutral_soft', macos_ocean_dark: 'neutral_soft', material_indigo_dark: 'neutral_soft', wechat_soft_dark: 'neutral_soft', vscode_modern_dark: 'neutral_soft', jetbrains_darcula: 'neutral_soft', oled_black_dark: 'neutral_soft', anime_neon_nightingale: 'neutral_soft'
  }
  const migrated = legacy[themeId]
  if (migrated !== undefined) return migrated
  if (THEMES.some((item) => item.id === themeId)) return themeId
  throw new Error(`未知配色方案：${themeId}`)
}
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
