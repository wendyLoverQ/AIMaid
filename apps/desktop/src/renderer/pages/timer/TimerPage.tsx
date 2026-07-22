import { Article, Container, InlineText, MainRegion, Pressable, ProductGrid, ProductHero, ProductMetric, ProductPage, ProductPanel, ProductStatusBar, ProductToolbar, ProductWorkspace, Strong, useToast } from "../../components/ui";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { Select } from '../../components/ui';
import { ContextMenuSurface } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { bridge } from '../../shared/bridge';
import { calculateTimerClock } from '../../../shared/timer-clock';
const QUICK_TIMES = [10, 15, 20, 25, 30] as const;
const DIGIT_COLORS = [
    ['深色', '#101820'],
    ['白色', '#FFFFFF'],
    ['绿色', '#18A058'],
    ['黄色', '#F2B705'],
    ['红色', '#D64545'],
    ['蓝色', '#2474D8']
] as const;
type TimerMode = 'idle' | 'countdown' | 'countup';
interface TimerRecord {
    id: string;
    savedAt: Date;
    durationSeconds: number;
}
export function TimerPage(): React.JSX.Element {
    const toast = useToast();
    const [mode, setMode] = useState<TimerMode>('idle');
    const [running, setRunning] = useState(false);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [remainingSeconds, setRemainingSeconds] = useState(0);
    const [recordsVisible, setRecordsVisible] = useState(false);
    const [transparent, setTransparent] = useState(false);
    const [digitColorIndex, setDigitColorIndex] = useState(0);
    const [records, setRecords] = useState<TimerRecord[]>([]);
    const startedAtRef = useRef<number | null>(null);
    const elapsedAtStartRef = useRef(0);
    const remainingAtStartRef = useRef(0);
    const completionAnnouncedRef = useRef(false);
    useEffect(() => { void loadRecords(setRecords).catch((reason: unknown) => toast.show(messageOf(reason), 'error')); }, [toast]);
    useEffect(() => {
        if (!running)
            return undefined;
        const update = (): void => {
            const startedAt = startedAtRef.current;
            if (startedAt === null) return;
            if (mode !== 'idle') {
                const clock = calculateTimerClock(mode, startedAt, elapsedAtStartRef.current, remainingAtStartRef.current, Date.now());
                setRemainingSeconds(clock.remainingSeconds);
                setElapsedSeconds(clock.elapsedSeconds);
                if (clock.completed) {
                    startedAtRef.current = null;
                    setRunning(false);
                    if (!completionAnnouncedRef.current) {
                        completionAnnouncedRef.current = true;
                        toast.show('倒计时结束。', 'success');
                        showSystemNotification('计时器', '倒计时结束。');
                    }
                }
            }
        };
        update();
        const timer = window.setInterval(update, 250);
        return () => window.clearInterval(timer);
    }, [mode, running, toast]);
    const displaySeconds = mode === 'countdown' ? remainingSeconds : elapsedSeconds;
    const timeText = formatClock(displaySeconds);
    const statusText = mode === 'idle'
        ? '待命中'
        : mode === 'countup'
            ? (running ? '正计时中' : '已暂停')
            : (running ? '倒计时中' : remainingSeconds === 0 ? '倒计时结束' : '已暂停');
    const digitColorName = (DIGIT_COLORS[digitColorIndex] ?? DIGIT_COLORS[0])[0];
    const startCountdown = (minutes: number): void => {
        requestNotificationPermission();
        setMode('countdown');
        setElapsedSeconds(0);
        setRemainingSeconds(minutes * 60);
        elapsedAtStartRef.current = 0;
        remainingAtStartRef.current = minutes * 60;
        startedAtRef.current = Date.now();
        completionAnnouncedRef.current = false;
        setRunning(true);
    };
    const startCountUp = (): void => {
        setMode('countup');
        setElapsedSeconds(0);
        setRemainingSeconds(0);
        elapsedAtStartRef.current = 0;
        remainingAtStartRef.current = 0;
        startedAtRef.current = Date.now();
        completionAnnouncedRef.current = false;
        setRunning(true);
    };
    const toggleRunning = (): void => {
        if (mode === 'idle') return;
        if (running) {
            const clock = calculateTimerClock(mode, startedAtRef.current, elapsedAtStartRef.current, remainingAtStartRef.current, Date.now());
            setElapsedSeconds(clock.elapsedSeconds); setRemainingSeconds(clock.remainingSeconds); elapsedAtStartRef.current = clock.elapsedSeconds; remainingAtStartRef.current = clock.remainingSeconds; startedAtRef.current = null; setRunning(false);
            return;
        }
        elapsedAtStartRef.current = elapsedSeconds; remainingAtStartRef.current = remainingSeconds; startedAtRef.current = Date.now(); setRunning(true);
    };
    const reset = (): void => {
        setMode('idle');
        setRunning(false);
        setElapsedSeconds(0);
        setRemainingSeconds(0);
        elapsedAtStartRef.current = 0; remainingAtStartRef.current = 0; startedAtRef.current = null; completionAnnouncedRef.current = false;
    };
    const saveRecord = async (): Promise<void> => {
        const durationSeconds = mode === 'idle' ? 0 : calculateTimerClock(mode, running ? startedAtRef.current : null, elapsedAtStartRef.current, remainingAtStartRef.current, Date.now()).elapsedSeconds;
        const record = { id: `timer_${crypto.randomUUID().replaceAll('-', '')}`, savedAt: new Date(), durationSeconds };
        const response = await bridge.core.invoke({ type: 'timer_record.save', payload: { record: { recordId: record.id, savedAt: record.savedAt.toISOString(), durationSeconds: record.durationSeconds } } });
        if (!response.success) { toast.show(response.error?.message ?? '计时记录保存失败。', 'error'); return; }
        setRecords((current) => [...current, record]);
        toast.show('记录已保存。', 'success');
    };
    if (transparent) {
        return <MainRegion>
      <Pressable onClick={() => setTransparent(false)}><Strong>{timeText}</Strong></Pressable>
    </MainRegion>;
    }
    return <ProductPage>
    <WindowTitleBar title="计时器"/>
    {recordsVisible
            ? <RecordsPage records={records} back={() => setRecordsVisible(false)} remove={async (id) => {
                    const response = await bridge.core.invoke({ type: 'timer_record.delete', payload: { recordId: id } });
                    if (!response.success) { toast.show(response.error?.message ?? '计时记录删除失败。', 'error'); return; }
                    setRecords((current) => current.filter((item) => item.id !== id));
                    toast.show('记录已删除。', 'success');
                }}/>
            : <ProductWorkspace layout="single" data-product="timer">
        <ProductHero eyebrow={statusText} value={timeText} detail={mode === 'idle' ? undefined : `本次已计时 ${formatDuration(elapsedSeconds)}`} actions={<><Button variant="primary" disabled={mode === 'idle' || (mode === 'countdown' && remainingSeconds === 0)} onClick={toggleRunning}>{running ? '暂停' : '继续计时'}</Button><Button disabled={mode === 'idle'} onClick={reset}>重置</Button></>}/>
        <ProductPanel title="快速开始">
          <ProductGrid density="quick-actions">
            {QUICK_TIMES.map((minutes) => <Button key={minutes} onClick={() => startCountdown(minutes)}>{minutes} 分钟</Button>)}
            <Button onClick={startCountUp}>从 0 开始</Button>
          </ProductGrid>
        </ProductPanel>
        <ProductPanel title="更多操作">
          <ProductGrid density="actions">
            <Button disabled={mode === 'idle'} onClick={() => void saveRecord()}>保存记录</Button>
            <Button onClick={() => setRecordsVisible(true)}>查看记录</Button><Button onClick={() => setTransparent(true)}>透明模式</Button>
            <Button onClick={() => setDigitColorIndex((value) => (value + 1) % DIGIT_COLORS.length)}>{digitColorName}</Button>
          </ProductGrid>
        </ProductPanel>
        <ProductStatusBar>{mode === 'countdown' && remainingSeconds === 0 ? '倒计时结束。' : `当前记录 ${records.length} 条 · 数字颜色 ${digitColorName}`}</ProductStatusBar>
      </ProductWorkspace>}
  </ProductPage>;
}
function RecordsPage({ records, back, remove }: {
    records: TimerRecord[];
    back: () => void;
    remove: (id: string) => Promise<void>;
}): React.JSX.Element {
    const now = new Date();
    const [year, setYear] = useState(now.getFullYear());
    const [month, setMonth] = useState(now.getMonth() + 1);
    const [contextMenu, setContextMenu] = useState<{
        id: string;
        x: number;
        y: number;
    } | null>(null);
    const years = useMemo(() => Array.from(new Set([now.getFullYear(), ...records.map((item) => item.savedAt.getFullYear())])).sort((a, b) => b - a), [records, now]);
    const monthRecords = records.filter((item) => item.savedAt.getFullYear() === year && item.savedAt.getMonth() + 1 === month);
    const yearRecords = records.filter((item) => item.savedAt.getFullYear() === year);
    return <ProductWorkspace layout="single" data-product="timer-records">
    <ProductToolbar lead={<Button onClick={back}>返回计时器</Button>} actions={<>
      <Select label="年份" value={String(year)} options={years.map((value) => ({ value: String(value), label: `${value} 年` }))} onChange={(event) => setYear(Number(event.target.value))}/>
      <Select label="月份" value={String(month)} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 月` }))} onChange={(event) => setMonth(Number(event.target.value))}/>
    </>}/>
    <ProductGrid density="metrics"><Stat scope="当月" records={monthRecords}/><Stat scope="当年" records={yearRecords}/><Stat scope="历史" records={records}/></ProductGrid>
    <ProductPanel title={`${year} 年 ${month} 月`} description={`${monthRecords.length} 条计时记录`} scroll>{monthRecords.length === 0
            ? <Container>暂无计时记录</Container>
            : <ProductGrid density="cards">{monthRecords.map((record) => <Article key={record.id} onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setContextMenu({ id: record.id, x: event.clientX, y: event.clientY });
                    }} title="右键删除记录"><Strong>{record.savedAt.getMonth() + 1}月{record.savedAt.getDate()}日</Strong><InlineText>{formatDuration(record.durationSeconds)}</InlineText></Article>)}</ProductGrid>}
    </ProductPanel>
    {contextMenu !== null ? <ContextMenuSurface label="计时记录操作" position={contextMenu} onClose={() => setContextMenu(null)} items={[
                { id: 'delete', label: '删除记录', danger: true, onSelect: () => void remove(contextMenu.id) }
            ]}/> : null}
  </ProductWorkspace>;
}
function Stat({ scope, records }: {
    scope: string;
    records: TimerRecord[];
}): React.JSX.Element {
    const durations = records.map((item) => item.durationSeconds);
    return <ProductMetric label={scope} value={`${records.length} 次`} detail={durations.length === 0 ? '暂无记录' : `最高 ${formatDuration(Math.max(...durations))} · 最低 ${formatDuration(Math.min(...durations))}`}/>;
}
function formatClock(seconds: number): string {
    const safe = Math.max(0, seconds);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const remaining = safe % 60;
    return hours >= 1 ? `${pad(hours)}:${pad(minutes)}:${pad(remaining)}` : `${pad(minutes)}:${pad(remaining)}`;
}
function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    if (hours >= 1)
        return `${hours}小时${minutes}分${remaining}秒`;
    if (minutes >= 1)
        return `${minutes}分${remaining}秒`;
    return `${remaining}秒`;
}
function pad(value: number): string { return value.toString().padStart(2, '0'); }
async function loadRecords(setRecords: (records: TimerRecord[]) => void): Promise<void> {
    const response = await bridge.core.invoke({ type: 'timer_record.list', payload: {} });
    if (!response.success || !Array.isArray(response.payload))
        throw new Error(response.error?.message ?? '计时记录读取失败。');
    setRecords((response.payload as unknown[]).flatMap((value) => {
        if (!isTimerRecordDto(value)) return [];
        return [{ id: value.recordId, savedAt: new Date(value.savedAt), durationSeconds: value.durationSeconds }];
    }));
}
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
function requestNotificationPermission(): void { if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission(); }
function showSystemNotification(title: string, body: string): void { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body }); }
function isTimerRecordDto(value: unknown): value is { recordId: string; savedAt: string; durationSeconds: number } {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.recordId === 'string' && typeof record.savedAt === 'string' && typeof record.durationSeconds === 'number';
}
