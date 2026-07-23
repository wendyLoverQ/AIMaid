import { Avatar, Page, PageContent, ProductPanel, ProductWorkspace, StatusDot, StatusHero, StatusMetric, StatusMetricGrid, StatusPanelGrid, StatusPanelTitle, WindowTitleBar } from '../../components/ui';
import type { StatusHealth } from '../../components/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CharacterDto, LlmBusinessModelConfigDto, ModelConfigurationDto } from '../../../shared/business';
import { bridge } from '../../shared/bridge';
import { loadCharacters } from '../../features/characters/character-api';
interface StatusSnapshot {
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
const EMPTY: StatusSnapshot = { currentCharacter: null, avatarUrl: '', roleState: null, tts: null, models: { chat: '--', cache: '--', proactive: '--' }, latencies: { chatLatencyMs: null, cacheLatencyMs: null, proactiveLatencyMs: null } };
export function StatusPage(): React.JSX.Element {
    const [snapshot, setSnapshot] = useState<StatusSnapshot>(EMPTY);
    const [resources, setResources] = useState<SystemResourceSnapshot | null>(null);
    const [network, setNetwork] = useState<NetworkProbe[]>([]);
    const [serverHealth, setServerHealth] = useState<ServerHealthSnapshot | null>(null);
    const [serverSummary, setServerSummary] = useState<ServerSummarySnapshot | null>(null);
    const [codexQuota, setCodexQuota] = useState<CodexQuotaView | null>(null);
    const refreshMain = useCallback(async (): Promise<void> => {
            const [characterResult, voiceResult, ttsResult, modelResult, businessResult] = await Promise.allSettled([
                loadCharacters(),
                bridge.core.invoke({ type: 'status.role', payload: {} }),
                bridge.core.invoke({ type: 'status.tts', payload: {} }, 5000),
                bridge.core.invoke({ type: 'model.list', payload: {} }),
                bridge.core.invoke({ type: 'business_model.list', payload: {} })
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
                currentCharacter,
                avatarUrl: avatar?.success ? avatar.payload?.url ?? '' : '',
                roleState: roleResponse,
                tts: ttsResponse,
                models: resolvedModels,
                latencies: latencyResult.success && latencyResult.payload !== null ? latencyResult.payload as StatusSnapshot['latencies'] : { chatLatencyMs: null, cacheLatencyMs: null, proactiveLatencyMs: null }
            });
            const errors: string[] = [];
            if (characterResult.status === 'rejected') errors.push(messageOf(characterResult.reason));
            if (voiceResult.status === 'rejected') errors.push(messageOf(voiceResult.reason)); else if (!voiceResult.value.success) errors.push(voiceResult.value.error?.message ?? '角色状态读取失败');
            if (ttsResult.status === 'rejected') errors.push(messageOf(ttsResult.reason)); else if (!ttsResult.value.success) errors.push(ttsResult.value.error?.message ?? 'TTS 状态读取失败');
            if (modelResult.status === 'rejected') errors.push(messageOf(modelResult.reason)); else if (!modelResult.value.success) errors.push(modelResult.value.error?.message ?? '模型读取失败');
            if (businessResult.status === 'rejected') errors.push(messageOf(businessResult.reason)); else if (!businessResult.value.success) errors.push(businessResult.value.error?.message ?? '业务模型读取失败');
            if (!latencyResult.success) errors.push(latencyResult.error?.message ?? '延迟读取失败');
            if (errors.length > 0) throw new Error(Array.from(new Set(errors)).join('；'));
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
    useStatusPoll(refreshMain, 3000);
    useStatusPoll(refreshQuota, 60000);
    useStatusPoll(refreshHealth, 60000);
    useStatusPoll(refreshSummary, 300000);
    useStatusPoll(refreshResources, 200);
    useStatusPoll(refreshNetwork, 3000);
    const character = snapshot.currentCharacter;
    return <Page>
    <WindowTitleBar title="状态面板"/>
    <PageContent scroll={false}>
      <ProductWorkspace layout="dashboard" data-product="status">
        <StatusPanelGrid>
          <ProductPanel title={<StatusPanelTitle icon="user">角色</StatusPanelTitle>}>
          <StatusHero compact avatar={<Avatar source={snapshot.avatarUrl} fallback={character?.name || '—'} size="md"/>} value={character?.name || '--'} detail={<>亲密等级 {snapshot.roleState?.intimacyLevel ?? '--'} / 5 · {snapshot.roleState?.intimacyLabel ?? '--'} · 最近 {snapshot.roleState?.hasMaidState ? snapshot.roleState.maidLastInteractionText : '--'}</>}/>
          <StatusMetricGrid columns={2}>
            <StatusMetric label="心情" value={snapshot.roleState?.hasMaidState ? snapshot.roleState.maidMoodText : '--'} tone="accent"/>
            <StatusMetric label="好感" value={snapshot.roleState?.hasMaidState ? snapshot.roleState.maidFavorability : '--'} tone="success"/>
            <StatusMetric label="陪伴" value={snapshot.roleState?.hasMaidState ? snapshot.roleState.maidCompanionshipText : '--'}/>
            <StatusMetric label="互动" value={snapshot.roleState?.hasMaidState ? `${snapshot.roleState.maidInteractionCount} 次` : '--'}/>
            <StatusMetric label="语音" value={character?.voiceName || character?.preferredVoiceId || '未配置'}/>
            <StatusMetric label="缓存" value={snapshot.roleState === null || snapshot.roleState.voiceCacheTotal <= 0 ? '--' : `${snapshot.roleState.voiceCacheCompleted}/${snapshot.roleState.voiceCacheTotal}`}/>
          </StatusMetricGrid>
          </ProductPanel>

          <ProductPanel title={<StatusPanelTitle icon="activity">核心服务</StatusPanelTitle>}>
            <StatusMetricGrid columns={2}>
            <StatusMetric wide
              label="TTS"
              state={snapshot.tts === null ? 'unknown' : snapshot.tts.online ? 'online' : 'offline'}
              value={snapshot.tts === null ? '--' : snapshot.tts.online ? '正常' : '异常'}
              detail={`${snapshot.tts?.lastLatencyMs ? `最近 ${formatLatency(snapshot.tts.lastLatencyMs)}` : '暂无记录'} · 处理中 ${snapshot.tts?.pendingSynthesisCount ?? '--'} · 待播放 ${snapshot.tts?.pendingPlaybackCount ?? '--'}`}
              tone={snapshot.tts?.online ? 'success' : snapshot.tts === null ? 'neutral' : 'danger'}
            />
            <StatusMetric label="对话模型" value={snapshot.models.chat} detail={formatModelLatency(snapshot.latencies.chatLatencyMs)} tone="accent"/>
            <StatusMetric label="缓存模型" value={snapshot.models.cache} detail={formatModelLatency(snapshot.latencies.cacheLatencyMs)}/>
            <StatusMetric wide label="主动模型" value={snapshot.models.proactive} detail={formatModelLatency(snapshot.latencies.proactiveLatencyMs)}/>
            </StatusMetricGrid>
          </ProductPanel>

          <ProductPanel title={<StatusPanelTitle icon="gauge">设备与网络</StatusPanelTitle>} description="本机资源 · TCP 443">
            <StatusMetricGrid columns={3}>
              <StatusMetric label="CPU" value={resources === null ? '--' : `${resources.cpuPercent.toFixed(0)}%`} meterPercent={resources?.cpuPercent ?? 0} tone="accent"/>
              <StatusMetric label="GPU" value={resources === null ? '--' : resources.gpuPercent === null ? 'N/A' : `${resources.gpuPercent.toFixed(0)}%`} meterPercent={resources?.gpuPercent ?? 0} tone="accent"/>
              <StatusMetric label="内存" value={resources === null ? '--' : `${resources.workingSetMb.toFixed(0)} MB`}/>
            </StatusMetricGrid>
            <StatusMetricGrid columns={3}>
              {['ChatGPT', 'Google', 'X', '抖音', '百度'].map((name) => {
                  const probe = network.find((item) => item.name === name);
                  const state: StatusHealth = probe === undefined ? 'unknown' : probe.success ? 'online' : 'offline';
                  return <StatusMetric
                    key={name}
                    label={name}
                    state={state}
                    value={probe === undefined ? '--' : probe.success ? `${probe.latencyMs ?? 0} ms` : '超时'}
                    tone={toneForHealth(state)}
                  />;
              })}
            </StatusMetricGrid>
          </ProductPanel>
        </StatusPanelGrid>

        <StatusPanelGrid variant="summary">
          <ServerPanel title="腾讯云" state={serverHealth === null ? 'unknown' : serverHealth.tencentCloud ? 'online' : 'offline'} summary={serverSummary?.tencentCloud ?? null}/>
          <ServerPanel title="AWS" state={serverHealth === null ? 'unknown' : serverHealth.aws ? 'online' : 'offline'} summary={serverSummary?.aws ?? null}/>
          <CodexQuotaPanel quota={codexQuota}/>
        </StatusPanelGrid>
      </ProductWorkspace>
    </PageContent>
  </Page>;
}

function ServerPanel({ title, state, summary }: { title: string; state: StatusHealth; summary: ServerSummary | null }): React.JSX.Element {
    return <ProductPanel title={<StatusPanelTitle icon="layers">{title}</StatusPanelTitle>} actions={<StatusDot state={state}/>}><StatusMetricGrid columns={3}>
        <ServerMetric label="内存" metric={summary?.memory ?? null}/>
        <ServerMetric label="磁盘" metric={summary?.disk ?? null}/>
        <ServerMetric label="本期流量" metric={summary?.traffic ?? null}/>
      </StatusMetricGrid></ProductPanel>;
}
function ServerMetric({ label, metric }: { label: string; metric: ServerCapacityMetric | null }): React.JSX.Element {
    const percent = metric === null || metric.totalBytes <= 0 ? 0 : Math.max(0, Math.min(100, metric.usedBytes * 100 / metric.totalBytes));
    const text = metric === null || metric.totalBytes <= 0 ? '-- / --' : `${formatBytes(metric.usedBytes)} / ${formatBytes(metric.totalBytes)}`;
    return <StatusMetric label={label} value={text} meterPercent={percent}/>;
}
function CodexQuotaPanel({ quota }: { quota: CodexQuotaView | null }): React.JSX.Element {
    if (quota === null)
        return <ProductPanel title={<StatusPanelTitle icon="sparkles">Codex 额度</StatusPanelTitle>} actions={<StatusDot state="unknown"/>}><StatusMetricGrid columns={1}><StatusMetric label="状态" value="未读取"/></StatusMetricGrid></ProductPanel>;
    if (!quota.loggedIn)
        return <ProductPanel title={<StatusPanelTitle icon="sparkles">Codex 额度</StatusPanelTitle>} actions={<StatusDot state="unknown"/>}><StatusMetricGrid columns={1}><StatusMetric label="状态" value="未登录"/></StatusMetricGrid></ProductPanel>;
    const account = `${quota.account || '当前用户'}${quota.plan && quota.plan.toLowerCase() !== 'unknown' ? ` · ${formatPlan(quota.plan)}` : ''}`;
    const remaining = [quota.primary?.remainingPercent, quota.secondary?.remainingPercent].filter((value): value is number => value !== undefined);
    const lowest = remaining.length > 0 ? Math.min(...remaining) : -1;
    const state: StatusHealth = lowest > 20 ? 'online' : lowest >= 0 ? 'offline' : 'unknown';
    return <ProductPanel title={<StatusPanelTitle icon="sparkles">Codex 额度</StatusPanelTitle>} description={quota.updatedAt || undefined} actions={<StatusDot state={state}/>}><StatusMetricGrid columns={2}>
        <StatusMetric wide label="账户" value={account} tone="accent"/>
        {quota.error ? <StatusMetric wide label="额度" value={quota.error} tone="danger"/> : <>
          {quota.primary !== null ? <StatusMetric label={quota.primary.label} value={`${Math.max(0, Math.min(100, quota.primary.remainingPercent)).toFixed(0)}%`} detail={quota.primary.resetsAt ? `重置于 ${quota.primary.resetsAt}` : undefined} meterPercent={quota.primary.remainingPercent} tone="success"/> : null}
          {quota.secondary !== null ? <StatusMetric label={quota.secondary.label} value={`${Math.max(0, Math.min(100, quota.secondary.remainingPercent)).toFixed(0)}%`} detail={quota.secondary.resetsAt ? `重置于 ${quota.secondary.resetsAt}` : undefined} meterPercent={quota.secondary.remainingPercent} tone="success"/> : null}
          {quota.credits !== null && quota.credits !== '' ? <StatusMetric wide label="Credits" value={quota.credits === 'unlimited' ? 'Unlimited' : quota.credits}/> : null}
        </>}
      </StatusMetricGrid></ProductPanel>;
}
function toneForHealth(state: StatusHealth): 'neutral' | 'success' | 'danger' {
    return state === 'online' ? 'success' : state === 'offline' ? 'danger' : 'neutral';
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

function useStatusPoll(task: () => Promise<void>, intervalMs: number): void {
    const taskRef = useRef(task);
    taskRef.current = task;
    useEffect(() => {
        let active = true;
        let timer: number | undefined;
        const run = async (): Promise<void> => {
            if (!active) return;
            try {
                await taskRef.current();
            } catch (reason) {
                console.error('Status poll failed:', messageOf(reason));
            } finally {
                if (active) timer = window.setTimeout(() => void run(), intervalMs);
            }
        };
        void run();
        return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
    }, [intervalMs]);
}

function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
