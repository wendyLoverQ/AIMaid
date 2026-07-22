export interface MarketCandle { openTime: string; open: number | string; high: number | string; low: number | string; close: number | string }
export function MarketChart({ candles, label }: { candles: readonly MarketCandle[]; label: string }): React.JSX.Element {
  const data = candles.map((item) => ({ time: item.openTime, open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close) })).filter((item) => [item.open, item.high, item.low, item.close].every(Number.isFinite)).slice(-80)
  if (data.length === 0) return <div className="ui-market-chart ui-market-chart--empty">暂无 K 线数据</div>
  const high = Math.max(...data.map((item) => item.high)); const low = Math.min(...data.map((item) => item.low)); const range = Math.max(high - low, 1)
  const y = (value: number): number => 12 + (high - value) / range * 276; const step = 960 / data.length; const bodyWidth = Math.max(2, step * .62)
  return <div className="ui-market-chart" role="img" aria-label={label}><svg viewBox="0 0 960 300" preserveAspectRatio="none">
    {data.map((item, index) => { const x = index * step + step / 2; const rising = item.close >= item.open; const color = rising ? 'var(--color-danger)' : 'var(--color-success)'; const bodyTop = y(Math.max(item.open, item.close)); const bodyHeight = Math.max(2, Math.abs(y(item.open) - y(item.close))); return <g key={`${item.time}-${index}`}><line x1={x} x2={x} y1={y(item.high)} y2={y(item.low)} stroke={color}/><rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color}/></g> })}
  </svg></div>
}
