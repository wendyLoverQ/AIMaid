import { Container, Header, Inline, InlineText, MediaImage, Paragraph, ProductGrid, ProductMetric, ProductPage, ProductPanel, ProductStatusBar, ProductToolbar, ProductWorkspace, Section, SmallText, Strong } from "../../components/ui";
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { Pressable } from '../../components/ui';
import { Input } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { bridge } from '../../shared/bridge';
import type { MarketSnapshotDto, MarketSymbolDto } from '../../../shared/business';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'SUI', 'TON'];
const INTERVALS = ['5 分钟', '15 分钟', '1 小时', '4 小时', '1 天', '1 周'];
const EMA = ['7', '25', '90', '120', '200'];
export function BitcoinPage(): React.JSX.Element {
    const [symbols, setSymbols] = useState(new Set(['BTC']));
    const [interval, setIntervalValue] = useState('15 分钟');
    const [ema, setEma] = useState(new Set(['7', '25']));
    const [dashboard, setDashboard] = useState(false);
    const [catalog, setCatalog] = useState<MarketSymbolDto[]>([]);
    const [query, setQuery] = useState('');
    const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshotDto>>({});
    const [snapshotErrors, setSnapshotErrors] = useState<Record<string, string>>({});
    const [status, setStatus] = useState('正在读取 Core 行情数据…');
    const toggle = (source: Set<string>, value: string, update: (next: Set<string>) => void): void => { const next = new Set(source); if (next.has(value)) next.delete(value); else next.add(value); update(next); };
    useEffect(() => {
        void bridge.core.invoke({ type: 'market.symbols', payload: {} }, 30000).then((response) => {
            if (!response.success || !Array.isArray(response.payload)) { setStatus(response.error?.message ?? '币种目录读取失败。'); return; }
            setCatalog(response.payload as MarketSymbolDto[]);
            setStatus(`已从 Core 读取 ${response.payload.length} 个 USDT 现货交易对。`);
        }).catch((error: unknown) => setStatus(messageOf(error, '币种目录读取失败。')));
    }, []);
    useEffect(() => {
        for (const symbol of symbols) {
          setSnapshotErrors((current) => { const next = { ...current }; delete next[symbol]; return next; });
          void bridge.core.invoke({ type: 'market.snapshot', payload: { symbol } }, 30000).then((response) => {
            if (!response.success || response.payload === null) {
              const message = response.error?.message ?? `${symbol} 行情读取失败。`;
              setSnapshotErrors((current) => ({ ...current, [symbol]: message }));
              setStatus(message);
              return;
            }
            setSnapshots((current) => ({ ...current, [symbol]: response.payload as MarketSnapshotDto }));
          }).catch((error: unknown) => {
            const message = messageOf(error, `${symbol} 行情读取失败。`);
            setSnapshotErrors((current) => ({ ...current, [symbol]: message }));
            setStatus(message);
          });
        }
    }, [symbols]);
    const matches = query.trim() === '' ? [] : catalog.filter((item) => item.symbol.includes(query.trim().toUpperCase()) || item.baseAsset.includes(query.trim().toUpperCase())).slice(0, 8);
    return <ProductPage>
    <WindowTitleBar title="BTC 行情"/>
    <ProductWorkspace layout="dashboard">
      <ProductToolbar lead={<><Button variant={dashboard ? 'secondary' : 'primary'} onClick={() => setDashboard(false)}>编辑模式</Button><Button variant={dashboard ? 'primary' : 'secondary'} onClick={() => setDashboard(true)}>看板模式</Button></>} actions={<><Button onClick={() => void bridge.window.open('crypto-chart')}>专业图表</Button><Button onClick={() => void bridge.window.open('crypto-provider')}>行情服务</Button><Button onClick={() => void bridge.window.open('crypto-events')}>事件中心</Button></>}/>
      {!dashboard ? <ProductPanel title="看板配置" actions={<SmallText>{symbols.size} 个资产</SmallText>}>
        <Container><Selector title="资产（可多选）" values={SYMBOLS} selected={symbols} select={(value) => toggle(symbols, value, setSymbols)}/>
          <Section><Input aria-label="搜索交易对" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key !== 'Enter' || matches[0] === undefined) return; setSymbols((current) => new Set(current).add(matches[0]!.baseAsset)); setQuery(''); }}/><SmallText>{query.trim() === '' ? `${catalog.length} 个交易对` : matches.length === 0 ? '没有匹配交易对' : matches[0]!.symbol}</SmallText></Section>
          <Selector title="周期" values={INTERVALS} selected={new Set([interval])} select={setIntervalValue}/>
          <Selector title="EMA 参数" values={EMA} selected={ema} select={(value) => toggle(ema, value, setEma)}/>
        </Container>
      </ProductPanel> : null}
      <ProductPanel title="市场快照" description={`${[...symbols].join(' / ')} · ${interval}`} scroll wide={dashboard}>
        <ProductGrid density="comfortable">{[...symbols].map((symbol) => <MarketCard key={symbol} symbol={symbol} snapshot={snapshots[symbol]} error={snapshotErrors[symbol]}/>)}</ProductGrid>
      </ProductPanel>
      <ProductStatusBar>{status}</ProductStatusBar>
    </ProductWorkspace>
  </ProductPage>;
}
function MarketCard({ symbol, snapshot, error }: {
    symbol: string;
    snapshot: MarketSnapshotDto | undefined;
    error: string | undefined;
}): React.JSX.Element {
    return <Section>
    <Header><Inline wrap={false}><MediaImage src={`aimaid-asset://ui/market_icons/${symbol.toLowerCase()}.png`} alt=""/><Container><Strong>{symbol}</Strong><InlineText>{snapshot === undefined ? '-- USDT' : `${formatNumber(snapshot.lastPrice)} USDT`}</InlineText></Container></Inline><Container><Strong>{snapshot === undefined ? '--%' : `${snapshot.priceChangePercent.toFixed(2)}%`}</Strong><InlineText>24h 最高 {snapshot === undefined ? '--' : formatNumber(snapshot.highPrice)} · 最低 {snapshot === undefined ? '--' : formatNumber(snapshot.lowPrice)}</InlineText><Button size="sm" onClick={() => void bridge.window.open('crypto-chart')}>专业图表</Button></Container></Header>
    <ProductGrid density="metrics"><Metric label="成交额" value={snapshot === undefined ? '--' : compact(snapshot.quoteVolume)}/><Metric label="资金费率" value={snapshot?.fundingRate == null ? '--' : `${(snapshot.fundingRate * 100).toFixed(4)}%`}/><Metric label="持仓量 OI" value={snapshot?.openInterest == null ? '--' : compact(snapshot.openInterest)}/><Metric label="盘口强弱" value={snapshot?.bidAskRatio == null ? '--' : snapshot.bidAskRatio.toFixed(2)}/></ProductGrid>
    <Paragraph>{error ?? (snapshot === undefined ? '正在读取 Core 行情快照…' : `更新于 ${new Date(snapshot.updatedAt).toLocaleTimeString('zh-CN')}`)}</Paragraph>
  </Section>;
}
function Metric({ label, value }: {
    label: string;
    value: string;
}): React.JSX.Element { return <ProductMetric label={label} value={value}/>; }
function Selector({ title, values, selected, select }: {
    title: string;
    values: string[];
    selected: Set<string>;
    select: (value: string) => void;
}): React.JSX.Element {
    return <Section><InlineText>{title}</InlineText><Inline gap="xs" wrap>{values.map((value) => <Pressable selected={selected.has(value)} key={value} onClick={() => select(value)}>{value}</Pressable>)}</Inline></Section>;
}
function formatNumber(value: number): string { return value >= 1000 ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : value.toLocaleString('zh-CN', { maximumFractionDigits: 8 }); }
function compact(value: number): string { const absolute = Math.abs(value); if (absolute >= 1e9) return `${(value / 1e9).toFixed(2)}B`; if (absolute >= 1e6) return `${(value / 1e6).toFixed(2)}M`; if (absolute >= 1e3) return `${(value / 1e3).toFixed(2)}K`; return value.toFixed(2); }
function messageOf(error: unknown, fallback: string): string { return error instanceof Error && error.message.trim() !== '' ? error.message : fallback; }
