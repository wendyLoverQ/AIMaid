import { Article, Container, FormLabel, Header, InlineText, MarketChart, Paragraph, ProductGrid, ProductMetric, ProductPage, ProductPanel, ProductStatusBar, ProductToolbar, ProductWorkspace, Section, SmallText, Strong, TimeValue } from "../../components/ui";
import type { MarketCandle } from "../../components/ui";
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { Input } from '../../components/ui';
import { Switch } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { bridge } from '../../shared/bridge';
import type { CryptoProviderConfigurationDto, MarketEventDto } from '../../../shared/business';
interface MarketEvent {
    id: string;
    symbol: string;
    side: 'SELL' | 'BUY';
    occurredAt: string;
    amount: number;
    price: number;
}
export function CryptoEventCenterPage(): React.JSX.Element {
    const [events, setEvents] = useState<MarketEvent[]>([]);
    const [status, setStatus] = useState('0 条事件');
    const refresh = async (): Promise<void> => {
        const response = await bridge.core.invoke({ type: 'market.list', payload: { limit: 500 } });
        if (!response.success || !Array.isArray(response.payload)) { setStatus(response.error?.message ?? '市场事件读取失败。'); return; }
        const loaded = (response.payload as MarketEventDto[]).map(toMarketEvent);
        setEvents(loaded);
        setStatus(`${loaded.length} 条事件`);
    };
    useEffect(() => { void refresh(); }, []);
    return <ProductPage>
    <WindowTitleBar title="市场事件中心" tools={<Button size="sm" onClick={() => void refresh()}>刷新</Button>}/>
    <ProductWorkspace layout="single">
      <ProductToolbar lead={<Paragraph>CoreHost 运行期间自动记录 Binance 全市场强平事件。链上大额转账、交易所流入和服务器事件采集尚未接入。</Paragraph>} actions={<SmallText>{status}</SmallText>}/>
      <ProductPanel title="实时事件流" scroll>
        {events.length === 0 ? <Section>暂无事件。保持应用运行即可持续接收全市场强平流；当前还没有服务器端链上事件源。</Section> : <ProductGrid density="comfortable">{events.map((event) => <MarketEventCard key={event.id} event={event}/>)}</ProductGrid>}
      </ProductPanel>
    </ProductWorkspace>
  </ProductPage>;
}
export function CryptoProviderSettingsPage(): React.JSX.Element {
    const [enabled, setEnabled] = useState(false);
    const [url, setUrl] = useState('');
    const [timeout, setTimeoutValue] = useState('8');
    const [status, setStatus] = useState('当前：现货 REST / 合约 REST / 实时流 → Binance 直连 · AI Provider 尚未检测');
    const [lastHealthStatus, setLastHealthStatus] = useState('未检测');
    const [lastHealthLatencyMs, setLastHealthLatencyMs] = useState<number | null>(null);
    const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
    useEffect(() => { void loadCryptoProvider(setEnabled, setUrl, setTimeoutValue, setLastHealthStatus, setLastHealthLatencyMs, setLastCheckedAt, setStatus); }, []);
    const validate = (requireServiceUrl: boolean): boolean => {
        const timeoutSeconds = Number(timeout);
        if (!/^\d+$/u.test(timeout.trim()) || timeoutSeconds < 1 || timeoutSeconds > 120) {
            setStatus('请求超时必须是 1 到 120 秒之间的整数。');
            return false;
        }
        if (requireServiceUrl) {
            try {
                const serviceUrl = new URL(url.trim());
                if (serviceUrl.protocol !== 'http:' && serviceUrl.protocol !== 'https:') throw new Error('unsupported protocol');
            }
            catch {
                setStatus('请输入有效的 HTTP 或 HTTPS AI Provider 地址。');
                return false;
            }
        }
        return true;
    };
    const configuration = (): CryptoProviderConfigurationDto => ({ isEnabled: enabled, serviceUrl: url.trim(), timeoutSeconds: Number(timeout), lastHealthStatus, lastHealthLatencyMs, lastCheckedAt });
    const save = async (): Promise<void> => {
        if (!validate(enabled))
            return;
        const response = await bridge.core.invoke({ type: 'crypto_provider.save', payload: { configuration: configuration() } });
        setStatus(response.success ? '已保存；下次行情刷新立即使用新连接方式。' : `保存失败：${response.error?.message ?? '未知错误'}`);
    };
    const check = async (): Promise<void> => {
        if (!validate(true))
            return;
        setStatus('正在检测 AI Provider…');
        const response = await bridge.core.invoke({ type: 'crypto_provider.check', payload: { configuration: configuration() } }, 120000);
        if (!response.success || !isRecord(response.payload)) {
            setStatus(`检测失败：${response.error?.message ?? '未知错误'}`);
            return;
        }
        const available = response.payload.available === true;
        const provider = typeof response.payload.provider === 'string' ? response.payload.provider : 'AI Provider';
        const latency = typeof response.payload.latencyMs === 'number' ? response.payload.latencyMs : 0;
        setLastHealthStatus(available ? provider : '不可用');
        setLastHealthLatencyMs(latency);
        setLastCheckedAt(new Date().toISOString());
        setStatus(available ? `服务正常 · ${provider} · 上游 ${latency} ms` : '服务不可用');
    };
    return <ProductPage>
    <WindowTitleBar title="加密行情服务"/>
    <ProductWorkspace layout="center">
      <ProductPanel title="连接设置" actions={<Switch label="现货 REST 使用 AI Provider" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/>} emphasis>
        <Container>
          <FormLabel><InlineText>连接方式</InlineText><Strong>{enabled ? 'AI Provider 代理' : 'Binance 直连'}</Strong></FormLabel>
          <Input label="AI Provider 地址" value={url} onChange={(event) => setUrl(event.target.value)}/>
          <Input label="请求超时（秒）" value={timeout} onChange={(event) => setTimeoutValue(event.target.value)}/>
          <ProductGrid density="metrics"><ProductMetric label="最近状态" value={lastHealthStatus}/><ProductMetric label="上游延迟" value={lastHealthLatencyMs === null ? '—' : `${lastHealthLatencyMs} ms`}/><ProductMetric label="检测时间" value={lastCheckedAt === null ? '尚未检测' : new Date(lastCheckedAt).toLocaleString('zh-CN')}/></ProductGrid>
          <ProductStatusBar actions={<><Button onClick={() => void check()}>检测服务</Button><Button variant="primary" onClick={() => void save()}>保存</Button></>}>{status}</ProductStatusBar>
        </Container>
      </ProductPanel>
    </ProductWorkspace>
  </ProductPage>;
}
async function loadCryptoProvider(setEnabled: (value: boolean) => void, setUrl: (value: string) => void, setTimeoutValue: (value: string) => void, setHealth: (value: string) => void, setLatency: (value: number | null) => void, setChecked: (value: string | null) => void, setStatus: (value: string) => void): Promise<void> {
    const response = await bridge.core.invoke({ type: 'crypto_provider.get', payload: {} });
    if (!response.success || !isCryptoProviderConfiguration(response.payload))
        return;
    const value = response.payload;
    setEnabled(value.isEnabled);
    setUrl(value.serviceUrl);
    setTimeoutValue(String(value.timeoutSeconds));
    setHealth(value.lastHealthStatus);
    setLatency(value.lastHealthLatencyMs);
    setChecked(value.lastCheckedAt);
    const route = value.isEnabled ? '当前：现货 REST → AI Provider；合约 REST / 实时流 → Binance 直连' : '当前：现货 REST / 合约 REST / 实时流 → Binance 直连';
    setStatus(value.lastCheckedAt === null ? `${route} · AI Provider 尚未检测` : `${route} · Provider ${value.lastHealthStatus} · ${value.lastHealthLatencyMs ?? '-'} ms · ${new Date(value.lastCheckedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
}
function isCryptoProviderConfiguration(value: unknown): value is CryptoProviderConfigurationDto { return isRecord(value) && typeof value.isEnabled === 'boolean' && typeof value.serviceUrl === 'string' && typeof value.timeoutSeconds === 'number'; }
function MarketEventCard({ event }: {
    event: MarketEvent;
}): React.JSX.Element {
    const side = event.side === 'SELL' ? '多单强平' : '空单强平';
    return <Article><Header><Strong>{event.symbol} · {side}</Strong><TimeValue>{new Date(event.occurredAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</TimeValue></Header><Paragraph>数量 {formatAmount(event.amount)} · 成交价 {event.price.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · 名义价值 {compact(event.amount * event.price)} USDT</Paragraph></Article>;
}
function formatAmount(value: number): string { return value.toFixed(4).replace(/\.?0+$/u, ''); }
function compact(value: number): string { const absolute = Math.abs(value); if (absolute >= 1e9)
    return `${(value / 1e9).toFixed(2)}B`; if (absolute >= 1e6)
    return `${(value / 1e6).toFixed(2)}M`; if (absolute >= 1e3)
    return `${(value / 1e3).toFixed(2)}K`; return value.toFixed(2).replace(/\.?0+$/u, ''); }
export function CryptoChartPage(): React.JSX.Element {
    const [status, setStatus] = useState('正在读取行情快照…');
    const [candles, setCandles] = useState<MarketCandle[]>([]);
    useEffect(() => {
        void bridge.core.invoke({ type: 'market.chart_snapshot', payload: { symbol: 'BTC', interval: '15m', emaPeriods: [7, 25] } }, 30000).then((response) => {
            if (!response.success || response.payload === null) { setStatus(response.error?.message ?? '行情快照读取失败。'); return; }
            const snapshot = response.payload as { candles?: MarketCandle[] };
            if (!Array.isArray(snapshot.candles) || snapshot.candles.length === 0) { setStatus('K 线快照为空。'); return; }
            setCandles(snapshot.candles); setStatus('BTCUSDT · 15 分钟 · Core 实时快照');
        });
    }, []);
    return <ProductPage>
    <WindowTitleBar title="BTC / USDT"/>
    <ProductWorkspace layout="single">
      <ProductPanel title="BTC / USDT" scroll><MarketChart candles={candles} label="BTC / USDT 15 分钟 K 线图"/></ProductPanel>
      <ProductStatusBar>{status}</ProductStatusBar>
    </ProductWorkspace>
  </ProductPage>;
}
function toMarketEvent(value: MarketEventDto): MarketEvent {
    let side: 'SELL' | 'BUY' = value.eventType.toLowerCase().includes('short') ? 'BUY' : 'SELL';
    try {
        const payload = JSON.parse(value.payloadJson) as { side?: unknown; o?: { S?: unknown } };
        const payloadSide = payload.side ?? payload.o?.S ?? value.address;
        if (payloadSide === 'BUY' || payloadSide === 'SELL') side = payloadSide;
    } catch { /* historical payload can be plain text */ }
    return { id: value.eventId, symbol: value.symbol, side, occurredAt: value.occurredAt, amount: value.amount ?? 0, price: value.price ?? 0 };
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
