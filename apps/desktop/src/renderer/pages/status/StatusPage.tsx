import { Avatar, Badge, Button, Container, Footer, Inline, InlineText, LayoutSlot, Meter, Page, PageContent, Section, SmallText, StatusBadge, Strong, Title2 } from '../../components/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CharacterDto, LlmBusinessModelConfigDto, ModelConfigurationDto } from '../../../shared/business';
import type { CoreStatus } from '../../../shared/core';
import type { PetRuntimeSnapshot } from '../../../shared/pet';
import { WindowTitleBar } from '../../components/ui';
import { bridge } from '../../shared/bridge';
import { loadCharacters } from '../../features/characters/character-api';
interface StatusSnapshot {
    core: CoreStatus | null;
    currentCharacter: CharacterDto | null;
    avatarUrl: string;
    roleState: StatusRoleState | null;
    tts: TtsRuntimeStatus | null;
    models: {
        chat: string;
        cache: string;
        proactive: string;
    };
    latencies: {
        chatLatencyMs: number | null;
        cacheLatencyMs: number | null;
        proactiveLatencyMs: number | null;
    };
    live2d: PetRuntimeSnapshot | null;
}
interface SystemResourceSnapshot {
    cpuPercent: number;
    gpuPercent: number | null;
    workingSetMb: number;
    managedMemoryMb: number;
}
interface NetworkProbe {
    name: string;
    latencyMs: number | null;
    success: boolean;
}
interface TtsRuntimeStatus {
    online: boolean;
    pendingSynthesisCount: number;
    pendingPlaybackCount: number;
    lastLatencyMs: number;
}
interface StatusRoleState {
    intimacyLevel: number;
    intimacyLabel: string;
    voiceCacheTotal: number;
    voiceCacheCompleted: number;
    hasMaidState: boolean;
    maidMoodText: string;
    maidFavorability: number;
    maidCompanionshipText: string;
    maidInteractionCount: number;
    maidLastInteractionText: string;
}
interface ServerCapacityMetric {
    usedBytes: number;
    totalBytes: number;
}
interface ServerSummary {
    memory: ServerCapacityMetric | null;
    disk: ServerCapacityMetric | null;
    traffic: ServerCapacityMetric | null;
}
interface ServerHealthSnapshot {
    tencentCloud: boolean;
    aws: boolean;
}
interface ServerSummarySnapshot {
    tencentCloud: ServerSummary | null;
    aws: ServerSummary | null;
}
interface CodexQuotaView {
    loggedIn: boolean;
    account: string;
    plan: string;
    updatedAt: string;
    primary: {
        label: string;
        remainingPercent: number;
        resetsAt: string;
    } | null;
    secondary: {
        label: string;
        remainingPercent: number;
        resetsAt: string;
    } | null;
    credits: string | null;
    error: string | null;
}
const EMPTY: StatusSnapshot = { core: null, currentCharacter: null, avatarUrl: '', roleState: null, tts: null, models: { chat: '--', cache: '--', proactive: '--' }, latencies: { chatLatencyMs: null, cacheLatencyMs: null, proactiveLatencyMs: null }, live2d: null };
export function StatusPage(): React.JSX.Element {
    const [snapshot, setSnapshot] = useState<StatusSnapshot>(EMPTY);
    const [resources, setResources] = useState<SystemResourceSnapshot | null>(null);
    const [network, setNetwork] = useState<NetworkProbe[]>([]);
    const [serverHealth, setServerHealth] = useState<ServerHealthSnapshot | null>(null);
    const [serverSummary, setServerSummary] = useState<ServerSummarySnapshot | null>(null);
    const [codexQuota, setCodexQuota] = useState<CodexQuotaView | null>(null);
    const refreshMain = useCallback(async (): Promise<void> => {
            const [coreResult, characterResult, voiceResult, ttsResult, modelResult, businessResult, live2dResult] = await Promise.allSettled([
                bridge.core.status(),
                loadCharacters(),
                bridge.core.invoke({ type: 'status.role', payload: {} }),
                bridge.core.invoke({ type: 'status.tts', payload: {} }, 5000),
                bridge.core.invoke({ type: 'model.list', payload: {} }),
                bridge.core.invoke({ type: 'business_model.list', payload: {} }),
                bridge.pet.runtimeStatus()
            ]);
            const currentCharacter = characterResult.status === 'fulfilled'
                ? characterResult.value.items.find((item) => item.roleId === characterResult.value.currentRoleId) ?? null
                : null;
            const avatar = currentCharacter?.avatarPath ? await bridge.media.registerLocalFile(currentCharacter.avatarPath) : null;
            const roleResponse = voiceResult.status === 'fulfilled' && voiceResult.value.success ? voiceResult.value.payload as StatusRoleState : null;
            const ttsResponse = ttsResult.status === 'fulfilled' && ttsResult.value.success ? ttsResult.value.payload as TtsRuntimeStatus : null;
            const modelConfigurations = modelResult.status === 'fulfilled' && modelResult.value.success && Array.isArray(modelResult.value.payload) ? modelResult.value.payload as ModelConfigurationDto[] : [];
            const businessConfigurations = businessResult.status === 'fulfilled' && businessResult.value.success && Array.isArray(businessResult.value.payload) ? businessResult.value.payload as LlmBusinessModelConfigDto[] : [];
            const resolvedModels = resolveStatusModels(modelConfigurations, businessConfigurations);
            const latencyResult = await bridge.core.invoke({ type: 'status.llm_latencies', payload: { chatModel: resolvedModels.chat === '--' ? '' : resolvedModels.chat, cacheModel: resolvedModels.cache === '--' ? '' : resolvedModels.cache, proactiveModel: resolvedModels.proactive === '--' ? '' : resolvedModels.proactive } });
            setSnapshot({
                core: coreResult.status === 'fulfilled' && coreResult.value.success ? coreResult.value.payload : null,
                currentCharacter,
                avatarUrl: avatar?.success ? avatar.payload?.url ?? '' : '',
                roleState: roleResponse,
                tts: ttsResponse,
                models: resolvedModels,
                latencies: latencyResult.success && latencyResult.payload !== null ? latencyResult.payload as StatusSnapshot['latencies'] : { chatLatencyMs: null, cacheLatencyMs: null, proactiveLatencyMs: null },
                live2d: live2dResult.status === 'fulfilled' && live2dResult.value.success ? live2dResult.value.payload : null
            });
            const errors: string[] = [];
            if (coreResult.status === 'rejected') errors.push(messageOf(coreResult.reason)); else if (!coreResult.value.success) errors.push(coreResult.value.error?.message ?? 'Core 状态读取失败');
            if (characterResult.status === 'rejected') errors.push(messageOf(characterResult.reason));
            if (voiceResult.status === 'rejected') errors.push(messageOf(voiceResult.reason)); else if (!voiceResult.value.success) errors.push(voiceResult.value.error?.message ?? '角色状态读取失败');
            if (ttsResult.status === 'rejected') errors.push(messageOf(ttsResult.reason)); else if (!ttsResult.value.success) errors.push(ttsResult.value.error?.message ?? 'TTS 状态读取失败');
            if (modelResult.status === 'rejected') errors.push(messageOf(modelResult.reason)); else if (!modelResult.value.success) errors.push(modelResult.value.error?.message ?? '模型读取失败');
            if (businessResult.status === 'rejected') errors.push(messageOf(businessResult.reason)); else if (!businessResult.value.success) errors.push(businessResult.value.error?.message ?? '业务模型读取失败');
            if (live2dResult.status === 'rejected') errors.push(messageOf(live2dResult.reason)); else if (!live2dResult.value.success) errors.push(live2dResult.value.error?.message ?? 'Live2D 状态读取失败');
            if (!latencyResult.success) errors.push(latencyResult.error?.message ?? '延迟读取失败');
            if (errors.length > 0) throw new Error(errors.join('；'));
    }, []);
    const refreshQuota = useCallback(async (): Promise<void> => {
            const response = await bridge.core.invoke({ type: 'status.codex_quota', payload: {} }, 15000);
            if (!response.success || response.payload === null) throw new Error(response.error?.message ?? 'Codex 额度读取失败');
            setCodexQuota(response.payload as CodexQuotaView);
    }, []);
    const refreshHealth = useCallback(async (): Promise<void> => {
            const response = await bridge.core.invoke({ type: 'status.server.health', payload: {} }, 25000);
            if (!response.success || response.payload === null) throw new Error(response.error?.message ?? '服务器健康状态读取失败');
            setServerHealth(response.payload as ServerHealthSnapshot);
    }, []);
    const refreshSummary = useCallback(async (): Promise<void> => {
            const response = await bridge.core.invoke({ type: 'status.server.summary', payload: {} }, 25000);
            if (!response.success || response.payload === null) throw new Error(response.error?.message ?? '服务器摘要读取失败');
            setServerSummary(response.payload as ServerSummarySnapshot);
    }, []);
    const refreshResources = useCallback(async (): Promise<void> => {
            const response = await bridge.core.invoke({ type: 'status.resources', payload: {} });
            if (!response.success || response.payload === null) throw new Error(response.error?.message ?? '系统资源读取失败');
            setResources(response.payload as SystemResourceSnapshot);
    }, []);
    const refreshNetwork = useCallback(async (): Promise<void> => {
            const response = await bridge.core.invoke({ type: 'status.network', payload: {} });
            if (!response.success || !Array.isArray(response.payload)) throw new Error(response.error?.message ?? '网络状态读取失败');
            setNetwork(response.payload as NetworkProbe[]);
    }, []);
    const [mainPoll, retryMain] = useStatusPoll(refreshMain, 3000);
    const [quotaPoll, retryQuota] = useStatusPoll(refreshQuota, 60000);
    const [healthPoll, retryHealth] = useStatusPoll(refreshHealth, 60000);
    const [summaryPoll, retrySummary] = useStatusPoll(refreshSummary, 300000);
    const [resourcesPoll, retryResources] = useStatusPoll(refreshResources, 200);
    const [networkPoll, retryNetwork] = useStatusPoll(refreshNetwork, 3000);
    const polls = [mainPoll, quotaPoll, healthPoll, summaryPoll, resourcesPoll, networkPoll];
    const refreshErrors = polls.flatMap((poll) => poll.error === null ? [] : [poll.error]);
    const lastSuccessfulAt = polls.reduce<number | null>((latest, poll) => poll.lastSuccessAt === null ? latest : Math.max(latest ?? 0, poll.lastSuccessAt), null);
    const retryAll = (): void => { retryMain(); retryQuota(); retryHealth(); retrySummary(); retryResources(); retryNetwork(); };
    const character = snapshot.currentCharacter;
    const live2dReady = snapshot.live2d?.rendererReady === true && snapshot.live2d.metrics?.state === 'ready';
    const healthStates = [snapshot.core === null ? 'unknown' : 'online', snapshot.tts === null ? 'unknown' : snapshot.tts.online ? 'online' : 'offline', snapshot.live2d === null ? 'unknown' : live2dReady ? 'online' : 'offline', serverHealth === null ? 'unknown' : serverHealth.tencentCloud ? 'online' : 'offline', serverHealth === null ? 'unknown' : serverHealth.aws ? 'online' : 'offline'];
    const normalCount = healthStates.filter((state) => state === 'online').length;
    const abnormalCount = healthStates.filter((state) => state === 'offline').length;
    const unknownCount = healthStates.filter((state) => state === 'unknown').length;
    return <Page>
    <WindowTitleBar title="状态面板"/>
    <PageContent>
      <LayoutSlot as="section" variant="status-overview"><Container><SmallText>整体健康</SmallText><Title2>{abnormalCount > 0 ? '存在异常' : unknownCount > 0 ? '部分状态读取中' : '运行正常'}</Title2><SmallText>数据自动刷新，服务与网络约每 3 秒更新。{lastSuccessfulAt === null ? '尚无成功刷新。' : `最后成功 ${new Date(lastSuccessfulAt).toLocaleTimeString('zh-CN')}。`}</SmallText></Container><Inline><Badge tone="success">正常 {normalCount}</Badge><Badge tone="danger">异常 {abnormalCount}</Badge><Badge>未知 {unknownCount}</Badge><Button size="sm" loading={polls.some((poll) => poll.refreshing)} onClick={retryAll}>立即重试</Button></Inline></LayoutSlot>
      {refreshErrors.length > 0 ? <LayoutSlot as="section" variant="status-overview" role="alert"><Container><Strong>部分状态刷新失败</Strong><SmallText>{Array.from(new Set(refreshErrors)).join('；')}</SmallText></Container><Button size="sm" onClick={retryAll}>重试失败项</Button></LayoutSlot> : null}
      <LayoutSlot variant="status-tier status-tier--primary">
      <StatusCard title="角色">
        <Container>
          <Avatar source={snapshot.avatarUrl} fallback={character?.name || '—'} size="sm"/>
          <Container><Strong>{character?.name || '--'}</Strong><InlineText>亲密等级 {snapshot.roleState?.intimacyLevel ?? '--'} / 5</InlineText></Container>
        </Container>
        <StatusLine label="语音" value={character?.voiceName || character?.preferredVoiceId || '未配置'}/>
        <Container><StatusLine label="阶段" value={snapshot.roleState?.intimacyLabel ?? '--'}/><StatusLine label="缓存" value={snapshot.roleState === null || snapshot.roleState.voiceCacheTotal <= 0 ? '--' : `${snapshot.roleState.voiceCacheCompleted}/${snapshot.roleState.voiceCacheTotal}`}/></Container>
        <Container><StatusLine label="心情" value={snapshot.roleState?.hasMaidState ? snapshot.roleState.maidMoodText : '--'}/><StatusLine label="好感" value={snapshot.roleState?.hasMaidState ? String(snapshot.roleState.maidFavorability) : '--'}/></Container>
        <Container><StatusLine label="陪伴" value={snapshot.roleState?.hasMaidState ? snapshot.roleState.maidCompanionshipText : '--'}/><StatusLine label="互动" value={snapshot.roleState?.hasMaidState ? `${snapshot.roleState.maidInteractionCount}次` : '--'}/></Container>
        <StatusLine label="最近互动" value={snapshot.roleState?.hasMaidState ? snapshot.roleState.maidLastInteractionText : '--'}/>
      </StatusCard>

      <StatusCard title="核心服务">
        <StatusDotLine label="TTS" state={snapshot.tts === null ? 'unknown' : snapshot.tts.online ? 'online' : 'offline'} value={snapshot.tts === null ? '--' : snapshot.tts.online ? '正常' : '异常'} detail={`${snapshot.tts?.lastLatencyMs ? `最近 ${formatLatency(snapshot.tts.lastLatencyMs)}` : '暂无记录'} · 处理中 ${snapshot.tts?.pendingSynthesisCount ?? '--'} · 待播放 ${snapshot.tts?.pendingPlaybackCount ?? '--'}`}/>
        <ModelLine label="对话" model={snapshot.models.chat} latency={formatModelLatency(snapshot.latencies.chatLatencyMs)}/>
        <ModelLine label="缓存" model={snapshot.models.cache} latency={formatModelLatency(snapshot.latencies.cacheLatencyMs)}/>
        <ModelLine label="主动" model={snapshot.models.proactive} latency={formatModelLatency(snapshot.latencies.proactiveLatencyMs)}/>
        <StatusDotLine label="Live2D" state={live2dReady ? 'online' : 'offline'} value={live2dReady ? '已连接' : '未连接'} detail={snapshot.live2d?.metrics === null || snapshot.live2d?.metrics === undefined ? '暂无渲染数据' : `${snapshot.live2d.metrics.fps.toFixed(0)} FPS · ${snapshot.live2d.metrics.state}`}/>
      </StatusCard>
      </LayoutSlot>

      <LayoutSlot variant="status-tier status-tier--secondary">
        <ServerCard title="腾讯云服务器" healthy={serverHealth?.tencentCloud ?? false} summary={serverSummary?.tencentCloud ?? null}/>
        <ServerCard title="AWS 服务器" healthy={serverHealth?.aws ?? false} summary={serverSummary?.aws ?? null}/>
        <CodexQuotaCard quota={codexQuota}/>
      </LayoutSlot>

      <LayoutSlot variant="status-tier status-tier--detail">
      <StatusCard title="系统资源">
        <ResourceLine label="CPU" value={resources === null ? '--' : `${resources.cpuPercent.toFixed(0)}%`} percent={resources?.cpuPercent ?? 0}/>
        <ResourceLine label="GPU" value={resources === null ? '--' : resources.gpuPercent === null ? 'N/A' : `${resources.gpuPercent.toFixed(0)}%`} percent={resources?.gpuPercent ?? 0}/>
        <StatusLine label="内存" value={resources === null ? '--' : `进程 ${resources.workingSetMb.toFixed(0)} MB  /  托管 ${resources.managedMemoryMb.toFixed(0)} MB`}/>
      </StatusCard>

      <StatusCard title="网络延迟（TCP 443）">
        {['ChatGPT', 'Google', 'X', '抖音', '百度'].map((name) => {
            const probe = network.find((item) => item.name === name);
            return <StatusDotLine key={name} state={probe === undefined ? 'unknown' : probe.success ? 'online' : 'offline'} value={`${name}  ${probe === undefined ? '--' : probe.success ? `${probe.latencyMs ?? 0} ms` : '超时'}`}/>;
        })}
      </StatusCard>
      </LayoutSlot>

      <Footer>资源 0.2s&nbsp; · &nbsp;服务 3s&nbsp; · &nbsp;服务器 1/5 分钟</Footer>
    </PageContent>
  </Page>;
}
function StatusCard({ title, children }: {
    title: string;
    children: React.ReactNode;
}): React.JSX.Element {
    return <Section><Title2>{title}</Title2>{children}</Section>;
}
function StatusLine({ label, value }: {
    label: string;
    value: string;
}): React.JSX.Element {
    return <Container><InlineText>{label}</InlineText><Strong>{value}</Strong></Container>;
}
function StatusDotLine({ label, state, value, detail }: {
    label?: string;
    state: 'online' | 'offline' | 'unknown';
    value: string;
    detail?: string;
}): React.JSX.Element {
    return <Container>{label !== undefined ? <InlineText>{label}</InlineText> : null}<StatusBadge tone={state === 'online' ? 'success' : state === 'offline' ? 'danger' : 'neutral'}>{state === 'online' ? '在线' : state === 'offline' ? '离线' : '未知'}</StatusBadge><Strong>{value}</Strong>{detail !== undefined ? <SmallText>{detail}</SmallText> : null}</Container>;
}
function ModelLine({ label, model, latency }: {
    label: string;
    model: string;
    latency: string;
}): React.JSX.Element {
    return <Container><InlineText>{label}</InlineText><Strong>{model}</Strong><SmallText>{latency}</SmallText></Container>;
}
function ServerCard({ title, healthy, summary }: {
    title: string;
    healthy: boolean;
    summary: ServerSummary | null;
}): React.JSX.Element {
    return <StatusCard title={title}>
    <StatusDotLine label="Health" state={healthy ? 'online' : 'offline'} value={healthy ? '正常' : '异常'}/>
    <ServerMetric label="内存" metric={summary?.memory ?? null}/>
    <ServerMetric label="磁盘" metric={summary?.disk ?? null}/>
    <ServerMetric label="本期流量" metric={summary?.traffic ?? null}/>
  </StatusCard>;
}
function CodexQuotaCard({ quota }: {
    quota: CodexQuotaView | null;
}): React.JSX.Element {
    if (quota === null)
        return <StatusCard title="Codex 额度"><StatusDotLine state="unknown" value="未读取 Codex 额度"/></StatusCard>;
    if (!quota.loggedIn)
        return <StatusCard title="Codex 额度"><StatusDotLine state="unknown" value="未登录 Codex"/></StatusCard>;
    const account = `${quota.account || '当前用户'}${quota.plan && quota.plan.toLowerCase() !== 'unknown' ? ` · ${formatPlan(quota.plan)}` : ''}${quota.updatedAt ? ` · ${quota.updatedAt}` : ''}`;
    const remaining = [quota.primary?.remainingPercent, quota.secondary?.remainingPercent].filter((value): value is number => value !== undefined);
    const lowest = remaining.length > 0 ? Math.min(...remaining) : -1;
    const state = lowest > 20 ? 'online' : lowest >= 0 ? 'offline' : 'unknown';
    return <StatusCard title="Codex 额度">
    <StatusDotLine state={state} value={account}/>
    {quota.error ? <StatusLine label="额度" value={quota.error}/> : <>
      {quota.primary !== null ? <QuotaLine quota={quota.primary}/> : null}
      {quota.secondary !== null ? <QuotaLine quota={quota.secondary}/> : null}
      {quota.credits !== null && quota.credits !== '' ? <StatusLine label="Credits" value={quota.credits === 'unlimited' ? 'Unlimited' : quota.credits}/> : null}
    </>}
  </StatusCard>;
}
function QuotaLine({ quota }: {
    quota: {
        label: string;
        remainingPercent: number;
        resetsAt: string;
    };
}): React.JSX.Element {
    return <StatusLine label={quota.label} value={`剩余 ${Math.max(0, Math.min(100, quota.remainingPercent)).toFixed(0)}%${quota.resetsAt ? ` → ${quota.resetsAt}` : ''}`}/>;
}
function ServerMetric({ label, metric }: {
    label: string;
    metric: ServerCapacityMetric | null;
}): React.JSX.Element {
    const percent = metric === null || metric.totalBytes <= 0 ? 0 : Math.max(0, Math.min(100, metric.usedBytes * 100 / metric.totalBytes));
    return <Container><Container><InlineText>{label}</InlineText><Strong>{metric === null || metric.totalBytes <= 0 ? '-- / --' : `${formatBytes(metric.usedBytes)} / ${formatBytes(metric.totalBytes)}`}</Strong></Container><Meter value={percent} max="100"/></Container>;
}
function ResourceLine({ label, value, percent = 0 }: {
    label: string;
    value: string;
    percent?: number;
}): React.JSX.Element {
    return <Container><InlineText>{label}</InlineText><Strong>{value}</Strong><Meter value={Math.max(0, Math.min(100, percent))} max="100"/></Container>;
}
function resolveStatusModels(models: readonly ModelConfigurationDto[], businesses: readonly LlmBusinessModelConfigDto[]): StatusSnapshot['models'] {
    const resolve = (businessKey: string): string => {
        const mapping = businesses.find((item) => item.businessKey === businessKey && item.isEnabled);
        if (mapping === undefined)
            return '--';
        return models.find((item) => item.modelKey === mapping.modelKey)?.model || '--';
    };
    return { chat: resolve('chat_reply'), cache: resolve('lazy_voice_cache'), proactive: resolve('proactive_decision') };
}
function formatLatency(milliseconds: number): string {
    return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${milliseconds.toFixed(0)}ms`;
}
function formatModelLatency(milliseconds: number | null): string {
    return milliseconds !== null && milliseconds > 0 ? `最近 ${formatLatency(milliseconds)}` : '暂无响应';
}
function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let scaled = Math.max(0, bytes);
    let index = 0;
    while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
    }
    return index === 0 ? `${scaled.toFixed(0)} ${units[index]}` : `${scaled.toFixed(2)} ${units[index]}`;
}
function formatPlan(plan: string): string {
    return plan.length === 0 ? '' : `${plan[0]!.toUpperCase()}${plan.slice(1).toLowerCase()}`;
}

interface StatusPollState {
    error: string | null;
    lastSuccessAt: number | null;
    refreshing: boolean;
}

function useStatusPoll(task: () => Promise<void>, intervalMs: number): [StatusPollState, () => void] {
    const taskRef = useRef(task);
    const retryRef = useRef<() => void>(() => undefined);
    const [state, setState] = useState<StatusPollState>({ error: null, lastSuccessAt: null, refreshing: false });
    taskRef.current = task;
    useEffect(() => {
        let active = true;
        let running = false;
        let retryAfterCurrent = false;
        let timer: number | undefined;
        const run = async (): Promise<void> => {
            if (!active) return;
            if (running) { retryAfterCurrent = true; return; }
            running = true;
            setState((current) => ({ ...current, refreshing: true }));
            try {
                await taskRef.current();
                if (active) setState({ error: null, lastSuccessAt: Date.now(), refreshing: false });
            } catch (reason) {
                if (active) setState((current) => ({ ...current, error: messageOf(reason), refreshing: false }));
            } finally {
                running = false;
                if (!active) return;
                if (retryAfterCurrent) { retryAfterCurrent = false; void run(); }
                else timer = window.setTimeout(() => void run(), intervalMs);
            }
        };
        retryRef.current = () => {
            if (timer !== undefined) window.clearTimeout(timer);
            timer = undefined;
            void run();
        };
        void run();
        return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
    }, [intervalMs]);
    return [state, () => retryRef.current()];
}

function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
