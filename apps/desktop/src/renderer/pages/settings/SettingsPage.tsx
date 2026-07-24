import { Accordion, Container, EmptyState, FormLabel, KeyboardKey, LayoutSlot, Page, PageContent, Paragraph, SearchBox, Section, SettingRow, SmallText, Strong, Title2, Title4 } from '../../components/ui';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui';
import { Pressable } from '../../components/ui';
import { Input } from '../../components/ui';
import { Select } from '../../components/ui';
import { Switch } from '../../components/ui';
import { Textarea } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { useToast } from '../../components/ui';
import { bridge } from '../../shared/bridge';
import { USER_CONFIGURATION_GROUPS } from './user-configuration-fields';
import { AgentDecisionSettings } from './AgentDecisionSettings';
import type { CharacterDto, LlmBusinessModelConfigDto, LlmSourcePromptDto, ModelConfigurationDto } from '../../../shared/business';
import type { ProactiveSourceDto } from '../../../shared/business';
import type { PetDisplayMode, PetPresentationSnapshot } from '../../../shared/presentation';
import { HOTKEY_ACTIONS } from '../../../shared/system-settings';
import type { HotkeyAction, PlatformSettingsSnapshot } from '../../../shared/system-settings';
import { MUSIC_VISUALIZER_STYLE_KEY, MUSIC_VISUALIZER_STYLE_OPTIONS, parseMusicVisualizerStyle } from '../../../shared/music-visualizer';
import type { MusicVisualizerStyle } from '../../../shared/music-visualizer';
import type { CryptoProviderConfigurationDto, DisturbanceSettingsDto } from '../../../shared/business';
const CATEGORIES = ['显示与窗口', 'AI 模型', 'AI 主动', 'Agent 决策', '语音 / TTS', '缓存与性能', '快捷键', '网络与服务', '高级 / 诊断'] as const;
type Category = (typeof CATEGORIES)[number];
const SEARCH_INDEX: Readonly<Record<Category, string>> = {
    '显示与窗口': '语言 显示模式 Live2D 模型 轮播时间 图库目录 开机自启动 气泡主题 音浪 样式 环绕 柱条 线条 底部',
    'AI 模型': '模型列表 编辑 新增模型 业务链 映射 API 密钥 endpoint',
    'AI 主动': 'AI 主动决策 主动语音 勿扰 模式',
    'Agent 决策': 'Agent 工具 能力 启用 确认 风险 结果策略 执行配置',
    '语音 / TTS': '实时 TTS 角色语音 播报',
    '缓存与性能': '语音缓存 周期 性能',
    '快捷键': '页面 功能 快捷键 录制 热键',
    '网络与服务': '网络 服务 行情 AI Provider 地址 超时 健康检查',
    '高级 / 诊断': '高级 诊断 用户配置 角色模板 Source Prompt 数据库'
};
const USER_CONFIGURATION_PREFIX = 'user_config:';
const IMAGE_INTERVAL_OPTIONS = [
    { seconds: 5, label: '5 秒' }, { seconds: 10, label: '10 秒' }, { seconds: 20, label: '20 秒' }, { seconds: 40, label: '40 秒' },
    { seconds: 60, label: '1 分钟' }, { seconds: 180, label: '3 分钟' }, { seconds: 300, label: '5 分钟' }, { seconds: 600, label: '10 分钟' }
] as const;
const AI_PROACTIVE_SOURCE_COOLDOWNS = [
    { minutes: 1, label: '1 分钟' },
    { minutes: 5, label: '5 分钟' },
    { minutes: 10, label: '10 分钟' },
    { minutes: 15, label: '15 分钟' },
    { minutes: 30, label: '30 分钟' },
    { minutes: 60, label: '1 小时' },
    { minutes: 180, label: '3 小时' }
] as const;
export function SettingsPage(): React.JSX.Element {
    const [category, setCategory] = useState<Category>('显示与窗口');
    const [search, setSearch] = useState('');
    const keyword = search.trim().toLocaleLowerCase();
    const matches = keyword === '' ? [] : CATEGORIES.filter((item) => `${item} ${SEARCH_INDEX[item]}`.toLocaleLowerCase().includes(keyword));
    return <Page>
    <WindowTitleBar title="系统设置"/>
    <PageContent scroll={false}><LayoutSlot variant="settings-workspace">
      <LayoutSlot as="aside" variant="settings-navigation"><SearchBox aria-label="搜索设置" value={search} onChange={setSearch}/><LayoutSlot as="nav" variant="settings-category-list" aria-label="设置分类">{CATEGORIES.map((item) => <Pressable key={item} selected={category === item} onClick={() => setCategory(item)}>{item}</Pressable>)}</LayoutSlot></LayoutSlot>
      <LayoutSlot as="main" variant="settings-content">{keyword !== '' ? <LayoutSlot as="header" variant="settings-content__header"><Title2>搜索结果</Title2><Paragraph>“{search.trim()}”匹配 {matches.length} 个分类</Paragraph></LayoutSlot> : null}
        {keyword !== '' ? matches.length === 0 ? <EmptyState title="没有匹配的设置"/> : <LayoutSlot variant="settings-search-results">{matches.map((item) => <Pressable appearance="card" key={item} onClick={() => { setCategory(item); setSearch(''); }}><Strong>{item}</Strong></Pressable>)}</LayoutSlot> : <SettingsCategory category={category} search={search}/>}
      </LayoutSlot>
    </LayoutSlot></PageContent>
  </Page>;
}
function SettingsCategory({ category, search }: {
    category: Category;
    search: string;
}): React.JSX.Element {
    const content = useMemo(() => {
        switch (category) {
            case '显示与窗口': return <DisplaySettings />;
            case 'AI 模型': return <ModelSettings />;
            case 'AI 主动': return <ProactiveDecisionSettings />;
            case 'Agent 决策': return <AgentDecisionSettings />;
            case '语音 / TTS': return <VoiceSettings />;
            case '缓存与性能': return <CacheSettings />;
            case '快捷键': return <HotkeySettings />;
            case '网络与服务': return <NetworkSettings />;
            case '高级 / 诊断': return <AdvancedSettings />;
        }
    }, [category]);
    if (search.trim() === '')
        return <><LayoutSlot as="header" variant="settings-category-header"><Title2>{category}</Title2><Paragraph>{categoryDescription(category)}</Paragraph></LayoutSlot>{content}</>;
    return <Container data-query={search}>{content}</Container>;
}
function categoryDescription(category: Category): string {
    return ({
        '显示与窗口': '调整桌宠显示、背景和窗口行为。',
        'AI 模型': '管理模型来源与业务映射。',
        'AI 主动': '调整 AI 主动触发、主动播报与勿扰行为。',
        'Agent 决策': '查看并配置 Agent 可以调用的工具能力。',
        '语音 / TTS': '管理角色语音与播报设置。',
        '缓存与性能': '调整语音缓存与性能相关选项。',
        '快捷键': '查看并设置页面与功能快捷键。',
        '网络与服务': '管理网络服务和外部服务连接。',
        '高级 / 诊断': '管理高级配置与诊断信息。'
    } as Record<Category, string>)[category];
}
function DisplaySettings(): React.JSX.Element {
    const toast = useToast();
    const [presentation, setPresentation] = useState<PetPresentationSnapshot | null>(null);
    const [language, setLanguage] = useState('zh-CN');
    const [bubbleStyle, setBubbleStyle] = useState('');
    const [visualizerStyle, setVisualizerStyle] = useState<MusicVisualizerStyle>('surround-line');
    const [platform, setPlatform] = useState<PlatformSettingsSnapshot | null>(null);
    useEffect(() => {
        void Promise.all([
            bridge.pet.presentation.get(),
            loadSettings(['ui_language', 'comic_bubble_style', MUSIC_VISUALIZER_STYLE_KEY]),
            bridge.systemSettings.get()
        ]).then(([presentationResponse, settings, platformResponse]) => {
            if (!presentationResponse.success || presentationResponse.payload === null)
                throw new Error(presentationResponse.error?.message ?? '显示设置读取失败。');
            if (!platformResponse.success || platformResponse.payload === null)
                throw new Error(platformResponse.error?.message ?? '系统平台设置读取失败。');
            setPresentation(presentationResponse.payload);
            setLanguage(settings.ui_language ?? 'zh-CN');
            setBubbleStyle(settings.comic_bubble_style ?? '');
            setVisualizerStyle(parseMusicVisualizerStyle(settings[MUSIC_VISUALIZER_STYLE_KEY]));
            setPlatform(platformResponse.payload);
        }).catch((reason: unknown) => toast.show(messageOf(reason), 'error'));
    }, []);
    async function setMode(mode: PetDisplayMode): Promise<void> {
        let current = presentation;
        for (let step = 0; current !== null && current.mode !== mode && step < 3; step += 1) {
            const response = await bridge.pet.presentation.execute('cycle-mode');
            if (!response.success || response.payload === null) {
                toast.show(response.error?.message ?? '显示模式切换失败。', 'error');
                return;
            }
            current = response.payload;
        }
        setPresentation(current);
    }
    async function setInterval(seconds: number): Promise<void> {
        let current = presentation;
        for (let step = 0; current !== null && current.imageIntervalSeconds !== seconds && step < 8; step += 1) {
            const response = await bridge.pet.presentation.execute('cycle-image-interval');
            if (!response.success || response.payload === null) {
                toast.show(response.error?.message ?? '轮播时间保存失败。', 'error');
                return;
            }
            current = response.payload;
        }
        setPresentation(current);
    }
    async function setLive2dRole(role: string): Promise<void> {
        let current = presentation;
        if (current === null || !current.live2dRoles.includes(role))
            return;
        for (let step = 0; current.live2dRole !== role && step < current.live2dRoles.length; step += 1) {
            const response = await bridge.pet.presentation.execute('switch-live2d-role');
            if (!response.success || response.payload === null) {
                toast.show(response.error?.message ?? 'Live2D 模型切换失败。', 'error');
                return;
            }
            current = response.payload;
        }
        setPresentation(current);
    }
    async function chooseFolder(): Promise<void> {
        const response = await bridge.pet.presentation.execute('choose-image-folder');
        if (response.success && response.payload !== null)
            setPresentation(response.payload);
        else
            toast.show(response.error?.message ?? '图库目录选择失败。', 'error');
    }
    async function saveLanguage(value: string): Promise<void> {
        try {
            await saveSettings({ ui_language: value });
            setLanguage(value);
            document.documentElement.lang = value;
            toast.show('语言设置已保存；当前窗口的语言标记已立即更新，已打开页面会在重新打开后载入对应语言包。', 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
    }
    async function saveBubbleStyle(value: string): Promise<void> {
        try {
            const response = await bridge.systemSettings.setBubbleStyle(value);
            if (!response.success)
                throw new Error(response.error?.message ?? '气泡主题保存失败。');
            setBubbleStyle(value);
            toast.show('气泡主题已保存并立即应用。', 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
    }
    async function saveVisualizerStyle(value: string): Promise<void> {
        const next = parseMusicVisualizerStyle(value);
        try {
            await saveSettings({ [MUSIC_VISUALIZER_STYLE_KEY]: next });
            setVisualizerStyle(next);
            toast.show('音浪样式已保存并立即应用。', 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
    }
    async function setAutoStart(enabled: boolean): Promise<void> {
        const response = await bridge.systemSettings.setAutoStart(enabled);
        if (!response.success || response.payload === null) {
            toast.show(response.error?.message ?? '开机自启动更新失败。', 'error');
            return;
        }
        setPlatform(response.payload);
        toast.show(enabled ? '开机自启动已开启。' : '开机自启动已关闭。', 'success');
    }
    return <LayoutSlot variant="settings-display-groups">
      <LayoutSlot as="section" variant="settings-display-group"><LayoutSlot as="header" variant="settings-display-group__heading"><Title4>基础显示</Title4></LayoutSlot><SettingCard title="语言包"><Select label="当前语言" value={language} onChange={(event) => void saveLanguage(event.target.value)} options={[{ value: 'zh-CN', label: '简体中文 · Chinese' }, { value: 'en', label: 'English · English' }, { value: 'es', label: 'Español · Spanish' }, { value: 'ja', label: '日本語 · Japanese' }]}/></SettingCard><SettingCard title={`显示模式：${presentation === null ? '读取中' : displayModeLabel(presentation.mode)}`}><Container>{([['image', '图片'], ['png-sequence', 'PNG'], ['live2d', 'Live2D']] as const).map(([mode, label]) => <Pressable key={mode} selected={presentation?.mode === mode} onClick={() => void setMode(mode)}>{label}</Pressable>)}</Container></SettingCard></LayoutSlot>
      <LayoutSlot as="section" variant="settings-display-group"><LayoutSlot as="header" variant="settings-display-group__heading"><Title4>音乐背景样式</Title4></LayoutSlot><SettingCard title="音乐音浪样式" description="音浪作为独立覆盖层显示，不参与图片、PNG 序列或 Live2D 的缩放。"><ValueChoice values={[...MUSIC_VISUALIZER_STYLE_OPTIONS]} selected={visualizerStyle} onSelect={(value) => void saveVisualizerStyle(value)}/></SettingCard></LayoutSlot>
      <LayoutSlot as="section" variant="settings-display-group"><LayoutSlot as="header" variant="settings-display-group__heading"><Title4>桌宠资源</Title4></LayoutSlot><SettingCard title="Live2D 模型"><Select disabled={presentation === null || presentation.live2dRoles.length < 2} value={presentation?.live2dRole ?? ''} onChange={(event) => void setLive2dRole(event.target.value)} options={(presentation?.live2dRoles ?? []).map((role) => ({ value: role, label: role }))}/></SettingCard><SettingCard title="轮播时间"><Container>{IMAGE_INTERVAL_OPTIONS.map((item) => <Pressable key={item.seconds} selected={presentation?.imageIntervalSeconds === item.seconds} onClick={() => void setInterval(item.seconds)}>{item.label}</Pressable>)}</Container></SettingCard><SettingCard title="图库目录"><Container><Input aria-label="图库目录" readOnly value={presentation?.imageRoot ?? ''}/><Button onClick={() => void chooseFolder()}>浏览</Button></Container></SettingCard><SettingCard title="开机自启动"><Switch disabled={platform === null} label="开机后自动启动女仆助手" checked={platform?.autoStartEnabled ?? false} onChange={(event) => void setAutoStart(event.target.checked)}/></SettingCard><SettingCard title={`气泡主题：${bubbleStyleLabel(bubbleStyle)}`}><ValueChoice values={[['', '自动（按内容）'], ['normal', '标准'], ['soft', '柔和'], ['lively', '活泼'], ['close', '亲密']]} selected={bubbleStyle} onSelect={(value) => void saveBubbleStyle(value)}/></SettingCard></LayoutSlot>
    </LayoutSlot>;
}
function ModelSettings(): React.JSX.Element {
    const toast = useToast();
    const [models, setModels] = useState<ModelConfigurationDto[] | null>(null);
    const [business, setBusiness] = useState<LlmBusinessModelConfigDto[] | null>(null);
    const [newKey, setNewKey] = useState('');
    const [newType, setNewType] = useState<'local' | 'api'>('local');
    const [busy, setBusy] = useState(false);
    async function load(): Promise<void> {
        const [modelResponse, businessResponse] = await Promise.all([
            bridge.core.invoke({ type: 'model.list', payload: {} }),
            bridge.core.invoke({ type: 'business_model.list', payload: {} })
        ]);
        if (!modelResponse.success || !Array.isArray(modelResponse.payload))
            throw new Error(modelResponse.error?.message ?? '模型配置读取失败。');
        if (!businessResponse.success || !Array.isArray(businessResponse.payload))
            throw new Error(businessResponse.error?.message ?? '业务模型读取失败。');
        setModels(modelResponse.payload as ModelConfigurationDto[]);
        setBusiness(businessResponse.payload as LlmBusinessModelConfigDto[]);
    }
    useEffect(() => { void load().catch((reason: unknown) => toast.show(messageOf(reason), 'error')); }, []);
    const updateModel = (key: string, patch: Partial<ModelConfigurationDto>): void => setModels((items) => items?.map((item) => item.modelKey === key ? { ...item, ...patch } : item) ?? null);
    async function saveModels(): Promise<void> {
        if (models === null)
            return;
        setBusy(true);
        try {
            const response = await bridge.core.invoke({ type: 'model.save', payload: { configurations: models } });
            if (!response.success)
                throw new Error(response.error?.message ?? '模型配置保存失败。');
            toast.show('模型配置已保存；聊天与角色模板等业务会在下一次调用时读取新配置。', 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
        finally {
            setBusy(false);
        }
    }
    async function addModel(): Promise<void> {
        setBusy(true);
        try {
            const response = await bridge.core.invoke({ type: 'model.add', payload: { modelKey: newKey.trim(), modelType: newType } });
            if (!response.success)
                throw new Error(response.error?.message ?? '无法新增模型。');
            setNewKey('');
            await load();
            toast.show('模型配置已创建，并已进入全部业务模型选择。', 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
        finally {
            setBusy(false);
        }
    }
    async function saveBusiness(): Promise<void> {
        if (business === null)
            return;
        setBusy(true);
        try {
            const response = await bridge.core.invoke({ type: 'business_model.save', payload: { configurations: business } });
            if (!response.success)
                throw new Error(response.error?.message ?? '业务模型保存失败。');
            toast.show('6 条业务链的独立模型配置已保存，下一次对应业务调用立即生效。', 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
        finally {
            setBusy(false);
        }
    }
    return <>
    <SettingCard title="各业务链条模型">{business === null || models === null ? <Paragraph>正在读取业务模型…</Paragraph> : business.map((item) => <Container key={item.businessKey}><FormLabel>{item.displayName}<SmallText>{item.businessKey}</SmallText></FormLabel><Select value={item.modelKey} onChange={(event) => setBusiness((rows) => rows?.map((row) => row.businessKey === item.businessKey ? { ...row, modelKey: event.target.value } : row) ?? null)} options={models.map((model) => ({ value: model.modelKey, label: `${model.modelKey}: ${model.model}` }))}/></Container>)}<Button variant="primary" loading={busy} disabled={business === null || models === null} onClick={() => void saveBusiness()}>保存全部业务模型</Button></SettingCard>
    <SettingCard title="模型配置">
      {models === null ? <Paragraph>正在读取模型配置…</Paragraph> : models.map((item) => <Section key={item.modelKey}><Title4>模型 · {item.modelKey}</Title4>
        <Select label="类型" value={item.type} onChange={(event) => updateModel(item.modelKey, { type: event.target.value as 'local' | 'api' })} options={[{ value: 'local', label: 'local' }, { value: 'api', label: 'api' }]}/>
        <Input label="服务地址" value={item.endpoint} onChange={(event) => updateModel(item.modelKey, { endpoint: event.target.value })}/>
        <Input label="模型名称" value={item.model} onChange={(event) => updateModel(item.modelKey, { model: event.target.value })}/>
        {item.type === 'api' ? <><Input label="API Key" type="password" autoComplete="new-password" value={item.apiKey} onChange={(event) => updateModel(item.modelKey, { apiKey: event.target.value })}/><Switch label="启用网页搜索" checked={item.enableWebSearch} onChange={(event) => updateModel(item.modelKey, { enableWebSearch: event.target.checked })}/></> : <Switch label="启用思考模式" checked={item.think} onChange={(event) => updateModel(item.modelKey, { think: event.target.checked })}/>}
      </Section>)}
      <Button variant="primary" loading={busy} disabled={models === null} onClick={() => void saveModels()}>保存模型配置</Button>
    </SettingCard>
    <SettingCard title="新增模型配置"><Container><Input aria-label="模型标识" value={newKey} onChange={(event) => setNewKey(event.target.value)}/><Select value={newType} onChange={(event) => setNewType(event.target.value as 'local' | 'api')} options={[{ value: 'local', label: '本地模型' }, { value: 'api', label: 'API 模型' }]}/><Button variant="primary" loading={busy} onClick={() => void addModel()}>新增模型</Button></Container></SettingCard>
  </>;
}
function ProactiveDecisionSettings(): React.JSX.Element {
    const toast = useToast();
    const [sources, setSources] = useState<ProactiveSourceDto[] | null>(null);
    const [testSource, setTestSource] = useState('');
    const [busy, setBusy] = useState('');
    async function load(): Promise<void> {
        const response = await bridge.core.invoke({ type: 'proactive.sources.list', payload: {} });
        if (!response.success || !Array.isArray(response.payload))
            throw new Error(response.error?.message ?? '主动数据源读取失败。');
        const rows = response.payload as ProactiveSourceDto[];
        setSources(rows);
        setTestSource((current) => current || rows[0]?.sourceKey || '');
    }
    useEffect(() => { void load().catch((reason: unknown) => toast.show(messageOf(reason), 'error')); }, []);
    async function update(item: ProactiveSourceDto): Promise<void> {
        setBusy(item.sourceKey);
        try {
            const response = await bridge.core.invoke({
                type: 'proactive.source.update',
                payload: { sourceKey: item.sourceKey, enabled: item.enabled, cooldownMinutes: item.cooldownMinutes }
            });
            if (!response.success)
                throw new Error(response.error?.message ?? '主动数据源保存失败。');
            await load();
            toast.show(`数据源已更新：${item.displayName}。`, 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
        finally {
            setBusy('');
        }
    }
    async function test(): Promise<void> {
        if (testSource === '')
            return;
        setBusy('test');
        try {
            const response = await bridge.core.invoke({ type: 'proactive.source.test', payload: { sourceKey: testSource } }, 120000);
            if (!response.success)
                throw new Error(response.error?.message ?? '单个数据源测试失败。');
            toast.show('单个数据源已进入主动决策与真实执行链。', 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
        finally {
            setBusy('');
        }
    }
    return <>
      <BooleanRuntimeSetting settingKey="ai_proactive_enabled" defaultValue title="AI 决策语音" label="启用 AI 决策语音" success={(value) => value ? 'AI 决策语音已开启。' : 'AI 决策语音已关闭。'}/>
      <DisturbanceSetting/>
      <SettingCard title="单个数据源测试" description="手动测试忽略自动冷却与评分阈值，不写入正式播报去重状态。">
        <Container><Select value={testSource} onChange={(event) => setTestSource(event.target.value)} options={(sources ?? []).map((source) => ({ value: source.sourceKey, label: `${source.displayName} · ${source.statusText}` }))}/><Button loading={busy === 'test'} disabled={sources === null || testSource === ''} onClick={() => void test()}>测试</Button></Container>
      </SettingCard>
      <SettingCard title="主动数据源">
        {sources === null ? <Paragraph>正在读取主动数据源…</Paragraph> : sources.map((source) => <Section key={source.sourceKey}>
          <Title4>{source.displayName} · {source.statusText}</Title4>
          <SmallText>{source.sourceKey} · 优先级 {source.priority} · 采集 {source.frequencyMinutes} 分钟 · 最近评分 {source.lastScore}</SmallText>
          <Switch label="启用数据源" checked={source.enabled} onChange={(event) => setSources((rows) => rows?.map((row) => row.sourceKey === source.sourceKey ? { ...row, enabled: event.target.checked } : row) ?? null)}/>
          <Select label="数据源冷却" value={String(source.cooldownMinutes)} options={[
              ...AI_PROACTIVE_SOURCE_COOLDOWNS.map((item) => ({ value: String(item.minutes), label: item.label })),
              ...(AI_PROACTIVE_SOURCE_COOLDOWNS.some((item) => item.minutes === source.cooldownMinutes)
                  ? []
                  : [{ value: String(source.cooldownMinutes), label: `${Math.max(1, source.cooldownMinutes)} 分钟` }])
          ]} onChange={(event) => setSources((rows) => rows?.map((row) => row.sourceKey === source.sourceKey ? { ...row, cooldownMinutes: Number(event.target.value) } : row) ?? null)}/>
          <Button loading={busy === source.sourceKey} onClick={() => void update(source)}>保存数据源</Button>
        </Section>)}
      </SettingCard>
    </>;
}
function VoiceSettings(): React.JSX.Element { return <BooleanRuntimeSetting settingKey="realtime_tts_enabled" defaultValue title="实时 TTS" label="实时生成并播放角色语音" success={(value) => value ? '实时 TTS 已开启。' : '实时 TTS 已关闭。'}/>; }
function CacheSettings(): React.JSX.Element {
    const toast = useToast();
    const [hours, setHours] = useState(1);
    useEffect(() => { void loadSettings(['voice_cache_period_hours']).then((values) => setHours(Number(values.voice_cache_period_hours ?? 1))).catch((reason: unknown) => toast.show(messageOf(reason), 'error')); }, []);
    async function select(value: string): Promise<void> { try {
        await saveSettings({ voice_cache_period_hours: value });
        setHours(Number(value));
        toast.show(`语音缓存周期已切换：${value} 小时。`, 'success');
    }
    catch (reason) {
        toast.show(messageOf(reason), 'error');
    } }
    return <SettingCard title={`语音缓存周期：${hours} 小时`}><ValueChoice values={[1, 2, 4, 8, 16].map((value) => [String(value), `${value} 小时`])} selected={String(hours)} onSelect={(value) => void select(value)}/></SettingCard>;
}
function HotkeySettings(): React.JSX.Element {
    const toast = useToast();
    const [selected, setSelected] = useState<HotkeyAction>(HOTKEY_ACTIONS[0].action);
    const [capturing, setCapturing] = useState(false);
    const [platform, setPlatform] = useState<PlatformSettingsSnapshot | null>(null);
    useEffect(() => { void bridge.systemSettings.get().then((response) => response.success && response.payload !== null ? setPlatform(response.payload) : toast.show(response.error?.message ?? '快捷键读取失败。', 'error')); }, []);
    const current = platform?.hotkeys.find((item) => item.action === selected)?.gesture ?? '';
    const capture = async (event: React.KeyboardEvent<HTMLDivElement>): Promise<void> => {
        if (!capturing)
            return;
        event.preventDefault();
        if (event.key === 'Escape') {
            setCapturing(false);
            return;
        }
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key))
            return;
        const parts: string[] = [];
        if (event.ctrlKey)
            parts.push('Ctrl');
        if (event.altKey)
            parts.push('Alt');
        if (event.shiftKey)
            parts.push('Shift');
        if (event.metaKey)
            parts.push('Win');
        parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
        setCapturing(false);
        const response = await bridge.systemSettings.setHotkey(selected, parts.join('+'));
        if (!response.success || response.payload === null) {
            toast.show(response.error?.message ?? '快捷键注册失败。', 'error');
            return;
        }
        setPlatform(response.payload);
        toast.show('全局快捷键已保存并立即重新注册。', 'success');
    };
    async function clear(): Promise<void> { const response = await bridge.systemSettings.setHotkey(selected, ''); if (!response.success || response.payload === null) {
        toast.show(response.error?.message ?? '快捷键禁用失败。', 'error');
        return;
    } ; setPlatform(response.payload); toast.show('快捷键已禁用。', 'success'); }
    return <SettingCard title="页面与功能快捷键">
    <Container tabIndex={-1} onKeyDown={(event) => void capture(event)}>
      <Select value={selected} onChange={(event) => { setSelected(event.target.value as HotkeyAction); setCapturing(false); }} options={HOTKEY_ACTIONS.map((item) => ({ value: item.action, label: item.label }))}/>
      <Container>
        <KeyboardKey>{capturing ? '请按下按键组合…（Esc 取消）' : current || '（已禁用）'}</KeyboardKey>
        <Button disabled={capturing} onClick={(event) => { setCapturing(true); event.currentTarget.closest<HTMLDivElement>('.hotkey-editor')?.focus(); }}>{capturing ? '录制中…' : '重新录制'}</Button>
        <Button disabled={capturing || current === ''} onClick={() => void clear()}>取消</Button>
      </Container>
      {current !== '' ? <Paragraph>点击「重新录制」后按下新的组合键；「取消」可禁用该快捷键。</Paragraph> : null}
    </Container>
  </SettingCard>;
}
function NetworkSettings(): React.JSX.Element {
    const toast = useToast();
    const [configuration, setConfiguration] = useState<CryptoProviderConfigurationDto | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { void bridge.core.invoke({ type: 'crypto_provider.get', payload: {} }).then((response) => { if (!response.success || response.payload === null)
        throw new Error(response.error?.message ?? '行情服务设置读取失败。'); setConfiguration(response.payload as CryptoProviderConfigurationDto); }).catch((reason: unknown) => toast.show(messageOf(reason), 'error')); }, []);
    async function execute(type: 'crypto_provider.save' | 'crypto_provider.check'): Promise<void> { if (configuration === null)
        return; setBusy(true); try {
        const response = await bridge.core.invoke({ type, payload: { configuration } });
        if (!response.success)
            throw new Error(response.error?.message ?? '行情服务操作失败。');
        if (type === 'crypto_provider.check' && response.payload !== null && typeof response.payload === 'object' && 'configuration' in response.payload)
            setConfiguration((response.payload as {
                configuration: CryptoProviderConfigurationDto;
            }).configuration);
        toast.show(type === 'crypto_provider.save' ? '行情服务设置已保存，下一次刷新立即生效。' : '行情服务健康检查完成。', 'success');
    }
    catch (reason) {
        toast.show(messageOf(reason), 'error');
    }
    finally {
        setBusy(false);
    } }
    return <SettingCard title="加密行情 AI Provider">{configuration === null ? <Paragraph>正在读取行情服务设置…</Paragraph> : <><Switch label="启用后 Spot REST 通过 AI Provider" checked={configuration.isEnabled} onChange={(event) => setConfiguration({ ...configuration, isEnabled: event.target.checked })}/><Input label="服务地址" value={configuration.serviceUrl} onChange={(event) => setConfiguration({ ...configuration, serviceUrl: event.target.value })}/><Input label="请求超时（秒）" value={String(configuration.timeoutSeconds)} onChange={(event) => setConfiguration({ ...configuration, timeoutSeconds: Number(event.target.value) })}/><Paragraph>最近检查：{configuration.lastHealthStatus}{configuration.lastHealthLatencyMs === null ? '' : ` · ${configuration.lastHealthLatencyMs} ms`}</Paragraph><Container><Button loading={busy} onClick={() => void execute('crypto_provider.check')}>健康检查</Button><Button loading={busy} variant="primary" onClick={() => void execute('crypto_provider.save')}>保存行情服务</Button></Container></>}</SettingCard>;
}
function AdvancedSettings(): React.JSX.Element {
    return <>
  <Accordion title="勿扰模式"><DisturbanceSetting /></Accordion>
  <Accordion title="用户配置覆盖"><UserConfigurationPanel /></Accordion>
  <Accordion title="当前角色模板诊断"><CharacterTemplateDiagnostics /></Accordion>
  <Accordion title="LLM Source Prompt"><SourcePromptSettings /></Accordion>
    </>;
}
function CharacterTemplateDiagnostics(): React.JSX.Element {
    const toast = useToast();
    const [role, setRole] = useState<CharacterDto | null>(null);
    const [busy, setBusy] = useState<'regenerate' | 'iterate' | null>(null);
    async function load(): Promise<void> {
        const [charactersResponse, settingsResponse] = await Promise.all([
            bridge.core.invoke({ type: 'character.list', payload: {} }),
            bridge.core.invoke({ type: 'settings.get', payload: { keys: ['voice_current_role_id'] } })
        ]);
        if (!charactersResponse.success || !Array.isArray(charactersResponse.payload))
            throw new Error(charactersResponse.error?.message ?? '角色列表读取失败。');
        if (!settingsResponse.success)
            throw new Error(settingsResponse.error?.message ?? '当前角色读取失败。');
        const settings = settingsResponse.payload as {
            settings?: Array<{
                key: string;
                value: string;
            }>;
        } | null;
        const currentRoleId = settings?.settings?.find((item) => item.key === 'voice_current_role_id')?.value ?? '';
        const characters = charactersResponse.payload as CharacterDto[];
        setRole(characters.find((item) => item.roleId === currentRoleId) ?? characters.find((item) => item.isEnabled) ?? null);
    }
    useEffect(() => { void load().catch((reason: unknown) => toast.show(messageOf(reason), 'error')); }, []);
    async function generate(continueIteration: boolean): Promise<void> {
        if (role === null)
            return;
        setBusy(continueIteration ? 'iterate' : 'regenerate');
        try {
            const response = await bridge.core.invoke({ type: 'character.template.generate', payload: { roleId: role.roleId, continueIteration } }, 120000);
            if (!response.success || response.payload === null)
                throw new Error(response.error?.message ?? '角色模板生成失败。');
            setRole(response.payload as CharacterDto);
            toast.show(continueIteration ? '当前角色模板已继续迭代。' : '当前角色模板已重新生成。', 'success');
        }
        catch (reason) {
            toast.show(messageOf(reason), 'error');
        }
        finally {
            setBusy(null);
        }
    }
    return <SettingCard title="当前角色模板诊断">
    {role === null ? <Paragraph>当前没有可诊断的启用角色。</Paragraph> : <>
      <Paragraph>角色：{role.name || role.roleId} · 状态：{role.templateCardGenerationStatus || '尚未生成'} · 已迭代 {role.templateCardIterationCount} 次</Paragraph>
      <Paragraph>最近生成：{formatDiagnosticTime(role.templateCardGeneratedAt)}{role.templateCardGenerationMessage ? ` · ${role.templateCardGenerationMessage}` : ''}</Paragraph>
      <Container><Button loading={busy === 'regenerate'} disabled={busy !== null} onClick={() => void generate(false)}>重新生成</Button><Button loading={busy === 'iterate'} disabled={busy !== null || role.templateCardJson === ''} onClick={() => void generate(true)}>继续迭代</Button></Container>
    </>}
  </SettingCard>;
}
function SourcePromptSettings(): React.JSX.Element {
    const toast = useToast();
    const [items, setItems] = useState<LlmSourcePromptDto[] | null>(null);
    const [selected, setSelected] = useState('');
    useEffect(() => {
        void (async () => {
            const response = await bridge.core.invoke({ type: 'source_prompt.list', payload: {} });
            if (!response.success || !Array.isArray(response.payload)) {
                toast.show(response.error?.message ?? 'Source Prompt 读取失败。', 'error');
                return;
            }
            const next = response.payload as LlmSourcePromptDto[];
            setItems(next);
            setSelected(next[0]?.sourceKey ?? '');
        })();
    }, []);
    const current = items?.find((item) => item.sourceKey === selected);
    const change = (patch: Partial<LlmSourcePromptDto>): void => setItems((rows) => rows?.map((item) => item.sourceKey === selected ? { ...item, ...patch } : item) ?? null);
    async function save(): Promise<void> {
        if (current === undefined)
            return;
        const response = await bridge.core.invoke({ type: 'source_prompt.save', payload: { prompt: current } });
        if (!response.success) {
            toast.show(response.error?.message ?? 'Source Prompt 保存失败。', 'error');
            return;
        }
        toast.show('当前 Source Prompt 已保存，下一次调用立即生效。', 'success');
    }
    return <SettingCard title="LLM Source Prompt">{items === null ? <Paragraph>正在读取 Source Prompt…</Paragraph> : items.length === 0 ? <Paragraph>数据库中没有现役 Source Prompt。</Paragraph> : <><Select value={selected} onChange={(event) => setSelected(event.target.value)} options={items.map((item) => ({ value: item.sourceKey, label: item.sourceKey }))}/><Textarea label="System Prompt" rows={5} value={current?.systemPromptTemplate ?? ''} onChange={(event) => change({ systemPromptTemplate: event.target.value })}/><Textarea label="User Prompt" rows={5} value={current?.userPromptTemplate ?? ''} onChange={(event) => change({ userPromptTemplate: event.target.value })}/><Textarea label="输出结构 JSON" rows={5} value={current?.outputSchemaJson ?? ''} onChange={(event) => change({ outputSchemaJson: event.target.value })}/><Button variant="primary" onClick={() => void save()}>保存当前 Source Prompt</Button></>}</SettingCard>;
}
function UserConfigurationPanel(): React.JSX.Element {
    const toast = useToast();
    const fields = useMemo(() => USER_CONFIGURATION_GROUPS.flatMap((group) => group.fields), []);
    const [values, setValues] = useState<Record<string, string>>({});
    const [dirty, setDirty] = useState<Set<string>>(() => new Set());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        let disposed = false;
        void (async () => {
            try {
                const loaded: Record<string, string> = {};
                for (let offset = 0; offset < fields.length; offset += 20) {
                    const keys = fields.slice(offset, offset + 20).map((field) => USER_CONFIGURATION_PREFIX + field.key);
                    const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys } });
                    if (!response.success)
                        throw new Error(response.error?.message ?? '用户配置读取失败。');
                    const payload = response.payload as {
                        settings?: Array<{
                            key: string;
                            value: string;
                        }>;
                    } | null;
                    for (const item of payload?.settings ?? [])
                        loaded[item.key.startsWith(USER_CONFIGURATION_PREFIX) ? item.key.slice(USER_CONFIGURATION_PREFIX.length) : item.key] = item.value;
                }
                if (!disposed)
                    setValues(loaded);
            }
            catch (reason) {
                if (!disposed)
                    toast.show(reason instanceof Error ? reason.message : String(reason), 'error');
            }
            finally {
                if (!disposed)
                    setLoading(false);
            }
        })();
        return () => { disposed = true; };
    }, [fields, toast]);
    function change(key: string, value: string): void {
        setValues((current) => ({ ...current, [key]: value }));
        setDirty((current) => new Set(current).add(key));
    }
    async function save(): Promise<void> {
        if (dirty.size === 0) {
            toast.show('当前配置没有修改。', 'info');
            return;
        }
        for (const key of dirty) {
            const field = fields.find((item) => item.key === key);
            const value = (values[key] ?? '').trim();
            if (field?.kind === 'integer' && !/^-?\d+$/.test(value)) {
                toast.show(`“${field.label}”必须是整数。`, 'error');
                return;
            }
            if (field?.kind === 'url' && value !== '') {
                try {
                    const url = new URL(value);
                    if (!['http:', 'https:'].includes(url.protocol))
                        throw new Error();
                }
                catch {
                    toast.show(`“${field.label}”必须是有效的 HTTP/HTTPS 地址。`, 'error');
                    return;
                }
            }
        }
        const changed = Object.fromEntries([...dirty].map((key) => [USER_CONFIGURATION_PREFIX + key, (values[key] ?? '').trim()]));
        try {
            setSaving(true);
            const response = await bridge.core.invoke({ type: 'settings.save', payload: { values: changed } });
            if (!response.success)
                throw new Error(response.error?.message ?? '用户配置保存失败。');
            setDirty(new Set());
            toast.show('用户配置已保存；TTS、代理和按次读取的消费者在下一次调用生效，进程启动型配置需重启应用。', 'success');
        }
        catch (reason) {
            toast.show(reason instanceof Error ? reason.message : String(reason), 'error');
        }
        finally {
            setSaving(false);
        }
    }
    return <SettingCard title="用户配置覆盖">
    <Button variant="primary" loading={saving} disabled={loading || dirty.size === 0} onClick={() => void save()}>{loading ? '正在读取…' : '保存当前配置'}</Button>
    {USER_CONFIGURATION_GROUPS.map((group) => <Section key={group.name}><Title4>{group.name}</Title4>{group.fields.map((field) => <Container key={field.key}><Strong>{field.label}</Strong><Container>{field.kind === 'boolean'
                    ? <Switch label="开" disabled={loading} checked={(values[field.key] ?? 'false').toLocaleLowerCase() === 'true'} onChange={(event) => change(field.key, String(event.target.checked))}/>
                    : <Input title={field.key} disabled={loading} value={values[field.key] ?? ''} onChange={(event) => change(field.key, event.target.value)}/>}</Container></Container>)}</Section>)}
  </SettingCard>;
}
function BooleanRuntimeSetting({ settingKey, defaultValue, title, label, success }: {
    settingKey: string;
    defaultValue: boolean;
    title: string;
    label: string;
    success: (value: boolean) => string;
}): React.JSX.Element {
    const toast = useToast();
    const [value, setValue] = useState(defaultValue);
    const [loading, setLoading] = useState(true);
    useEffect(() => { void loadSettings([settingKey]).then((settings) => setValue(settings[settingKey] === undefined ? defaultValue : settings[settingKey]?.toLocaleLowerCase() === 'true')).catch((reason: unknown) => toast.show(messageOf(reason), 'error')).finally(() => setLoading(false)); }, [defaultValue, settingKey, toast]);
    async function change(next: boolean): Promise<void> { try {
        await saveSettings({ [settingKey]: String(next) });
        setValue(next);
        toast.show(success(next), 'success');
    }
    catch (reason) {
        toast.show(messageOf(reason), 'error');
    } }
    return <SettingCard title={title}><Switch disabled={loading} label={label} checked={value} onChange={(event) => void change(event.target.checked)}/></SettingCard>;
}
function DisturbanceSetting(): React.JSX.Element {
    const toast = useToast();
    const [settings, setSettings] = useState<DisturbanceSettingsDto | null>(null);
    const [saving, setSaving] = useState(false);
    useEffect(() => { void bridge.core.invoke({ type: 'disturbance_settings.get', payload: {} }).then((response) => { if (!response.success || response.payload === null)
        throw new Error(response.error?.message ?? '勿扰设置读取失败。'); setSettings(response.payload as DisturbanceSettingsDto); }).catch((reason: unknown) => toast.show(messageOf(reason), 'error')); }, []);
    async function save(next: DisturbanceSettingsDto, message: string): Promise<void> {
        setSaving(true);
        try {
        const response = await bridge.core.invoke({ type: 'disturbance_settings.save', payload: { settings: next } });
        if (!response.success)
            throw new Error(response.error?.message ?? '勿扰设置保存失败。');
        setSettings(next);
        toast.show(message, 'success');
    }
    catch (reason) {
        toast.show(messageOf(reason), 'error');
    }
    finally {
        setSaving(false);
    } }
    function patch(value: Partial<DisturbanceSettingsDto>): void {
        setSettings((current) => current === null ? null : { ...current, ...value, updatedAt: new Date().toISOString() });
    }
    return <SettingCard title={`勿扰模式：${disturbanceLabel(settings?.mode ?? 'normal')}`}>
      {settings === null ? <Paragraph>正在读取勿扰设置…</Paragraph> : <>
        <ValueChoice values={[['normal', '正常'], ['quiet', '安静'], ['focus', '专注'], ['game', '游戏'], ['sleep', '睡眠']]} selected={settings.mode} onSelect={(value) => { const next = { ...settings, mode: value as DisturbanceSettingsDto['mode'], updatedAt: new Date().toISOString() }; void save(next, `勿扰模式：${disturbanceLabel(value)}。主动决策消费者已立即切换。`); }}/>
        <Switch label="启用静默时段" checked={settings.quietHoursEnabled} onChange={(event) => patch({ quietHoursEnabled: event.target.checked })}/>
        <Container><Input label="静默开始" type="time" value={settings.quietHoursStart} onChange={(event) => patch({ quietHoursStart: event.target.value })}/><Input label="静默结束" type="time" value={settings.quietHoursEnd} onChange={(event) => patch({ quietHoursEnd: event.target.value })}/></Container>
        <Switch label="全屏时抑制低优先级主动行为" checked={settings.suppressWhenFullscreen} onChange={(event) => patch({ suppressWhenFullscreen: event.target.checked })}/>
        <Input label="每小时最多主动次数" type="number" min={0} max={100} value={String(settings.maxProactivePerHour)} onChange={(event) => patch({ maxProactivePerHour: Number(event.target.value) })}/>
        <Button variant="primary" loading={saving} onClick={() => void save(settings, '勿扰、静默时段和每小时次数已保存。')}>保存勿扰设置</Button>
      </>}
    </SettingCard>;
}
function SettingCard({ title, description, children }: {
    title: string;
    description?: string;
    children: React.ReactNode;
}): React.JSX.Element { return <SettingRow title={title} {...(description === undefined ? {} : { description })} control={<Container>{children}</Container>} />; }
function ValueChoice({ values, selected, onSelect }: {
    values: Array<readonly [
        string,
        string
    ]>;
    selected: string;
    onSelect: (value: string) => void;
}): React.JSX.Element { return <Container>{values.map(([value, label]) => <Pressable key={value} selected={selected === value} onClick={() => onSelect(value)}>{label}</Pressable>)}</Container>; }
async function loadSettings(keys: string[]): Promise<Record<string, string>> { const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys } }); if (!response.success)
    throw new Error(response.error?.message ?? '设置读取失败。'); const payload = response.payload as {
    settings?: Array<{
        key: string;
        value: string;
    }>;
} | null; return Object.fromEntries((payload?.settings ?? []).map((item) => [item.key, item.value])); }
async function saveSettings(values: Record<string, string>): Promise<void> { const response = await bridge.core.invoke({ type: 'settings.save', payload: { values } }); if (!response.success)
    throw new Error(response.error?.message ?? '设置保存失败。'); }
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
function displayModeLabel(mode: PetDisplayMode): string { return mode === 'image' ? '图片' : mode === 'png-sequence' ? 'PNG' : 'Live2D'; }
function bubbleStyleLabel(value: string): string { return value === 'normal' ? '标准' : value === 'soft' ? '柔和' : value === 'lively' ? '活泼' : value === 'close' ? '亲密' : '自动'; }
function disturbanceLabel(value: string): string { return value === 'quiet' ? '安静' : value === 'focus' ? '专注' : value === 'game' ? '游戏' : value === 'sleep' ? '睡眠' : '正常'; }
function formatDiagnosticTime(value: string | null): string { if (!value)
    return '尚未生成'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN'); }
