import { useEffect, useRef, useState } from 'react'
import type { AppearanceConfigurationDto } from '../../../shared/business'
import { Badge, ColorPalette, Container, LayoutSlot, Page, PageContent, Pressable, SegmentedControl, SettingRow, SettingsSection, Stack, Strong, Switch, Text, WindowTitleBar, useToast } from '../../components/ui'
import { bridge } from '../../shared/bridge'
import { saveAndApplyAppearance } from './appearance-runtime'
import { MUSIC_VISUALIZER_STYLE_KEY, MUSIC_VISUALIZER_STYLE_OPTIONS, parseMusicVisualizerStyle } from '../../../shared/music-visualizer'
import type { MusicVisualizerStyle } from '../../../shared/music-visualizer'

interface ThemeDefinition { id: string; name: string; description: string; colors: readonly [string, string, string, string] }
const THEMES: readonly ThemeDefinition[] = [
  theme('harbor_blue', '港湾蓝', '清爽、沉静', '#EAF2F8', '#DDEAF4', '#FFFFFF', '#286F9D'),
  theme('cedar_green', '雪松绿', '自然、专注', '#EEF2EB', '#DFE9DC', '#FEFFFD', '#4C7650'),
  theme('amber_sand', '琥珀砂', '温暖、柔和', '#F7F0E3', '#ECE1CC', '#FFFDFC', '#A66A24'),
  theme('rose_clay', '玫瑰陶', '克制、雅致', '#F8ECEC', '#F0DCDD', '#FFFDFD', '#B34F5F'),
  theme('lavender_haze', '薰衣草雾', '轻盈、舒缓', '#F2EEF8', '#E5DCF1', '#FFFEFF', '#7655A6'),
  theme('sea_glass', '海盐青', '通透、平和', '#E8F3F1', '#D8E9E5', '#FCFFFE', '#287C72'),
  theme('river_stone', '河岸石', '中性、耐看', '#F0F0EC', '#E4E3DC', '#FEFEFC', '#5B6864'),
  theme('apricot_glow', '杏子光', '明快、亲和', '#F7EEE8', '#EEDDD1', '#FFFDFC', '#BB6444'),
  theme('iris_blue', '鸢尾蓝', '理性、优雅', '#EDF0F8', '#DDE3F2', '#FFFFFF', '#4F67A8')
]
const DEFAULT_CONFIGURATION: AppearanceConfigurationDto = { themeId: 'sea_glass', contentBrightness: 'Standard', fontFamily: '', fontScale: 1, cornerRadiusStyle: 'Medium', density: 'Standard', headerStyle: 'Subtle', animationsEnabled: true }

export function AppearanceSettingsPage(): React.JSX.Element {
  const toast = useToast()
  const [configuration, setConfiguration] = useState(DEFAULT_CONFIGURATION)
  const [visualizerStyle, setVisualizerStyle] = useState<MusicVisualizerStyle>('surround-line')
  const revision = useRef(0)
  useEffect(() => {
    void Promise.all([
      bridge.core.invoke({ type: 'appearance.get', payload: {} }),
      bridge.core.invoke({ type: 'settings.get', payload: { keys: [MUSIC_VISUALIZER_STYLE_KEY] } })
    ]).then(([response, settingsResponse]) => {
      if (!response.success) throw new Error(response.error?.message ?? '外观设置读取失败。')
      if (!settingsResponse.success) throw new Error(settingsResponse.error?.message ?? '音浪样式读取失败。')
      const source = response.payload as AppearanceConfigurationDto
      const loaded = { ...source, themeId: normalizeThemeId(source.themeId) }
      const settingsPayload = settingsResponse.payload as { settings?: Array<{ key: string; value: string }> } | null
      const visualizerSetting = settingsPayload?.settings?.find((item) => item.key === MUSIC_VISUALIZER_STYLE_KEY)?.value
      setConfiguration(loaded); setVisualizerStyle(parseMusicVisualizerStyle(visualizerSetting)); saveAndApplyAppearance(loaded, colorsFor(loaded.themeId))
      if (loaded.themeId !== source.themeId) {
        void bridge.core.invoke({ type: 'appearance.save', payload: { configuration: loaded } }).then((migration) => {
          if (!migration.success) throw new Error(migration.error?.message ?? '旧版外观设置迁移失败。')
        }).catch((reason: unknown) => toast.show(messageOf(reason), 'error'))
      }
    }).catch((reason: unknown) => toast.show(reason instanceof Error ? reason.message : String(reason), 'error'))
  }, [toast])
  async function saveVisualizerStyle(value: string): Promise<void> {
    const next = parseMusicVisualizerStyle(value)
    const response = await bridge.core.invoke({ type: 'settings.save', payload: { values: { [MUSIC_VISUALIZER_STYLE_KEY]: next } } })
    if (!response.success) throw new Error(response.error?.message ?? '音浪样式保存失败。')
    setVisualizerStyle(next)
    toast.show('音浪样式已保存并立即应用。', 'success')
  }
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
    <PageContent><LayoutSlot variant="appearance-content"><LayoutSlot variant="appearance-workspace">
      <LayoutSlot as="aside" variant="appearance-themes"><SettingsSection title="配色方案"><LayoutSlot variant="theme-card-grid">{THEMES.map((item) => <ThemeCard key={item.id} item={item} selected={configuration.themeId === item.id} select={() => update({ themeId: item.id })} />)}</LayoutSlot></SettingsSection></LayoutSlot>
      <LayoutSlot as="main" variant="appearance-controls">
        <LayoutSlot as="section" variant="appearance-controls__section"><SettingsSection title="内容与字体">
        <SettingRow title="内容亮度" control={<SegmentedControl label="内容亮度" value={configuration.contentBrightness} onChange={(contentBrightness) => update({ contentBrightness })} options={[{ value: 'Soft', label: '柔和' }, { value: 'Standard', label: '标准' }, { value: 'Clear', label: '清晰' }]} />} />
        <SettingRow title="字体方案" control={<SegmentedControl label="字体方案" value={configuration.fontFamily} onChange={(fontFamily) => update({ fontFamily })} options={[{ value: '', label: '默认' }, { value: 'Microsoft YaHei UI', label: '微软雅黑' }]} />} />
        <SettingRow title="字号缩放" control={<SegmentedControl label="字号缩放" value={String(configuration.fontScale)} onChange={(fontScale) => update({ fontScale: Number(fontScale) })} options={[{ value: '0.9', label: '90%' }, { value: '1', label: '100%' }, { value: '1.1', label: '110%' }, { value: '1.2', label: '120%' }]} />} />
        </SettingsSection></LayoutSlot>
        <LayoutSlot as="section" variant="appearance-controls__section"><SettingsSection title="音乐音浪"><SettingRow title="音乐音浪样式" description="音浪作为独立覆盖层显示，不参与图片、PNG 序列或 Live2D 的缩放。" control={<Container>{MUSIC_VISUALIZER_STYLE_OPTIONS.map(([value, label]) => <Pressable key={value} selected={visualizerStyle === value} onClick={() => void saveVisualizerStyle(value).catch((reason: unknown) => toast.show(messageOf(reason), 'error'))}>{label}</Pressable>)}</Container>} /></SettingsSection></LayoutSlot>
        <LayoutSlot as="section" variant="appearance-controls__section"><SettingsSection title="密度与圆角">
        <SettingRow title="圆角风格" control={<SegmentedControl label="圆角风格" value={configuration.cornerRadiusStyle} onChange={(cornerRadiusStyle) => update({ cornerRadiusStyle })} options={[{ value: 'Small', label: '小' }, { value: 'Medium', label: '中' }, { value: 'Large', label: '大' }]} />} />
        <SettingRow title="界面密度" control={<SegmentedControl label="界面密度" value={configuration.density} onChange={(density) => update({ density })} options={[{ value: 'Compact', label: '紧凑' }, { value: 'Standard', label: '标准' }, { value: 'Comfortable', label: '宽松' }]} />} />
        </SettingsSection></LayoutSlot>
        <LayoutSlot as="section" variant="appearance-controls__section"><SettingsSection title="窗口与动画"><SettingRow title="顶部样式" control={<SegmentedControl label="窗口顶部样式" value={configuration.headerStyle} onChange={(headerStyle) => update({ headerStyle })} options={[{ value: 'None', label: '不显示' }, { value: 'Subtle', label: '柔和' }, { value: 'AccentStrip', label: '主题色顶栏' }, { value: 'Filled', label: '主题色标题栏' }]} />} /><SettingRow title="界面动画" control={<Switch label={configuration.animationsEnabled ? '已开启' : '已关闭'} checked={configuration.animationsEnabled} onChange={(event) => update({ animationsEnabled: event.target.checked })} />} /></SettingsSection></LayoutSlot>
      </LayoutSlot>
    </LayoutSlot></LayoutSlot></PageContent>
  </Page>
}

function ThemeCard({ item, selected, select }: { item: ThemeDefinition; selected: boolean; select: () => void }): React.JSX.Element {
  return <Pressable appearance="card" selected={selected} aria-current={selected ? 'true' : undefined} onClick={select}>
    <LayoutSlot as="span" variant="theme-card__preview"><ColorPalette colors={item.colors} /></LayoutSlot>
    <LayoutSlot as="span" variant="theme-card__meta">
      <Stack gap="xs"><Strong>{item.name}</Strong><Text size="xs" tone="muted">{item.description}</Text></Stack>
      {selected ? <Badge tone="accent">当前方案</Badge> : null}
    </LayoutSlot>
  </Pressable>
}
function theme(id: string, name: string, description: string, ...colors: [string, string, string, string]): ThemeDefinition { return { id, name, description, colors } }
function colorsFor(themeId: string): readonly [string, string, string, string] {
  const selected = THEMES.find((item) => item.id === themeId)
  if (selected === undefined) throw new Error(`未知配色方案：${themeId}`)
  return selected.colors
}
function normalizeThemeId(themeId: string): string {
  const legacy: Readonly<Record<string, string>> = {
    fluent_fog: 'harbor_blue', macos_mist: 'harbor_blue', material_sage: 'cedar_green', wechat_soft: 'sea_glass', notion_paper: 'amber_sand', slack_aubergine: 'lavender_haze', neutral_soft: 'river_stone', cream_paper: 'amber_sand', cool_slate: 'iris_blue', anime_sakura_cream: 'rose_clay', anime_mint_soda: 'sea_glass', anime_peach_cream: 'apricot_glow', anime_sky_sailor: 'harbor_blue', anime_candy_park: 'lavender_haze',
    fluent_fog_light: 'harbor_blue', macos_mist_light: 'harbor_blue', material_sage_light: 'cedar_green', wechat_soft_light: 'sea_glass', notion_paper_light: 'amber_sand', slack_aubergine_light: 'lavender_haze', neutral_soft_light: 'river_stone', cream_paper_light: 'amber_sand', cool_slate_light: 'iris_blue', fluent_graphite_dark: 'river_stone', macos_ocean_dark: 'harbor_blue', material_indigo_dark: 'iris_blue', wechat_soft_dark: 'sea_glass', vscode_modern_dark: 'river_stone', jetbrains_darcula: 'river_stone', oled_black_dark: 'river_stone', anime_neon_nightingale: 'lavender_haze'
  }
  const migrated = legacy[themeId]
  if (migrated !== undefined) return migrated
  if (THEMES.some((item) => item.id === themeId)) return themeId
  throw new Error(`未知配色方案：${themeId}`)
}
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
