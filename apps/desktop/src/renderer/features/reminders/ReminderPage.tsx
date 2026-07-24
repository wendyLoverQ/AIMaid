import { Badge, Button, Dialog, EmptyState, ErrorState, Grid, Inline, Input, LayoutSlot, Loading, Page, PageContent, PageToolbar, SegmentedControl, Stack, Strong, Surface, Switch, Text, Textarea, WindowTitleBar, useToast } from '../../components/ui';
import { useEffect, useMemo, useState } from 'react';
import type { ReminderDto, ReminderSavePayload } from '../../../shared/business';
import { deleteReminder, listReminders, processDueReminders, saveReminder, setReminderAllowTts, setReminderEnabled } from './reminder-api';
export function ReminderPage(): React.JSX.Element {
    const toast = useToast();
    const [items, setItems] = useState<ReminderDto[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<ReminderDto | 'new' | null>(null);
    const [deleting, setDeleting] = useState<ReminderDto | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    async function load(): Promise<void> {
        try {
            setError(null);
            setItems(await listReminders());
        }
        catch (reason) {
            setError(message(reason));
        }
    }
    useEffect(() => { void load(); }, []);
    async function mutate(id: string, operation: () => Promise<unknown>): Promise<void> {
        try {
            setBusyId(id);
            await operation();
            await load();
        }
        catch (reason) {
            toast.show(message(reason), 'error');
        }
        finally {
            setBusyId(null);
        }
    }
    if (items === null)
        return <Page><WindowTitleBar title="提醒事项"/><PageContent>{error === null ? <Loading label="正在读取提醒事项"/> : <ErrorState title="提醒事项读取失败" message={error} onRetry={() => void load()}/>}</PageContent></Page>;
    return <Page>
    <WindowTitleBar title="提醒事项"/>
    <PageContent>
    <Stack gap="md">
      <PageToolbar lead={<Inline><Strong>{items.length} 项提醒</Strong><Text tone="secondary">启用 {items.filter((item) => item.enabled).length} 项</Text></Inline>} actions={<Button variant="primary" onClick={() => setEditing('new')}>新增提醒</Button>} />
      {items.length === 0 ? <EmptyState title="暂无提醒"/> : <LayoutSlot variant="reminder-list">
        {items.map((item) => <Surface variant="reminder-row" key={item.reminderId}>
          <LayoutSlot variant="reminder-row__time"><Badge tone={item.enabled ? 'accent' : 'neutral'}>{item.enabled ? '已启用' : '已关闭'}</Badge><Strong>{formatDate(item.nextDueAt ?? item.dueAt)}</Strong></LayoutSlot>
          <Stack gap="xs"><Strong>{item.title}</Strong>{item.message.trim() !== '' ? <Text as="p" tone="secondary" wrap>{item.message}</Text> : <Text tone="muted">没有附加内容</Text>}</Stack>
          <Inline><Badge>{item.repeat === 'daily' ? '每天重复' : '仅一次'}</Badge><Badge>{item.allowTts ? 'TTS 播报' : '静默提醒'}</Badge></Inline>
          <Inline justify="end"><Switch label="提醒" checked={item.enabled} disabled={busyId === item.reminderId} onChange={(event) => void mutate(item.reminderId, () => setReminderEnabled(item.reminderId, event.target.checked))}/><Switch label="TTS" checked={item.allowTts} disabled={busyId === item.reminderId} onChange={(event) => void mutate(item.reminderId, () => setReminderAllowTts(item.reminderId, event.target.checked))}/><Button size="sm" onClick={() => setEditing(item)}>编辑</Button><Button size="sm" variant="danger" onClick={() => setDeleting(item)}>删除</Button></Inline>
        </Surface>)}
      </LayoutSlot>}
      <Inline justify="end"><Button size="sm" onClick={() => void load()}>刷新</Button><Button size="sm" onClick={() => void mutate('check', processDueReminders)}>检查</Button></Inline>
    </Stack>
    <ReminderEditor item={editing} close={() => setEditing(null)} saved={() => { setEditing(null); void load(); }}/>
    <Dialog open={deleting !== null} title="确认删除" description={deleting === null ? '' : `删除提醒 [${deleting.title}]？`} onClose={() => setDeleting(null)} footer={<><Button onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" onClick={() => { const item = deleting; if (item === null)
        return; setDeleting(null); void mutate(item.reminderId, () => deleteReminder(item.reminderId)); }}>删除</Button></>}><Text as="p" wrap>删除后无法在页面中恢复。</Text></Dialog>
    </PageContent>
  </Page>;
}
function ReminderEditor({ item, close, saved }: {
    item: ReminderDto | 'new' | null;
    close: () => void;
    saved: () => void;
}): React.JSX.Element {
    const source = item === 'new' || item === null ? null : item;
    const initialDue = useMemo(() => toLocalInput(source?.nextDueAt ?? source?.dueAt ?? new Date(Date.now() + 600000).toISOString()), [source]);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [dueDate, setDueDate] = useState(initialDue.slice(0, 10));
    const [dueTime, setDueTime] = useState(initialDue.slice(11, 16));
    const [repeat, setRepeat] = useState<'none' | 'daily'>('none');
    const [enabled, setEnabled] = useState(true);
    const [allowTts, setAllowTts] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dueIsValid = /^\d{2}:\d{2}$/.test(dueTime) && !Number.isNaN(new Date(`${dueDate}T${dueTime}:00`).getTime());
    useEffect(() => {
        setTitle(source?.title ?? '');
        setContent(source?.message ?? '');
        setDueDate(initialDue.slice(0, 10));
        setDueTime(initialDue.slice(11, 16));
        setRepeat(source?.repeat ?? 'none');
        setEnabled(source?.enabled ?? true);
        setAllowTts(source?.allowTts ?? true);
        setError(null);
    }, [initialDue, source]);
    async function submit(): Promise<void> {
        if (!/^\d{2}:\d{2}$/.test(dueTime)) {
            setError('时间格式请写成 HH:mm，例如 23:30。');
            return;
        }
        const date = new Date(`${dueDate}T${dueTime}:00`);
        if (Number.isNaN(date.getTime())) {
            setError('请选择有效日期，并按 HH:mm 输入时间。');
            return;
        }
        if (repeat === 'none' && date.getTime() <= Date.now()) {
            setError('一次性提醒必须选择未来时间。');
            return;
        }
        const cleanTitle = title.trim() === '' ? '提醒' : title.trim();
        const payload: ReminderSavePayload = { reminderId: source?.reminderId ?? null, title: cleanTitle, message: content.trim() === '' ? cleanTitle : content.trim(), dueAt: date.toISOString(), repeat, enabled, allowTts };
        try {
            setSaving(true);
            setError(null);
            await saveReminder(payload);
            saved();
        }
        catch (reason) {
            setError(message(reason));
        }
        finally {
            setSaving(false);
        }
    }
    return <Dialog open={item !== null} title={source === null ? '新增提醒' : '编辑提醒'} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" loading={saving} disabled={!dueIsValid} onClick={() => void submit()}>保存</Button></>}>
    <Stack gap="lg">
      <LayoutSlot as="section" variant="dialog-form-section"><Strong>内容</Strong><Input label="标题" value={title} onChange={(event) => setTitle(event.target.value)}/><Textarea label="内容" value={content} onChange={(event) => setContent(event.target.value)}/></LayoutSlot>
      <LayoutSlot as="section" variant="dialog-form-section"><Strong>时间规则</Strong><Grid columns="two"><Input label="日期" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)}/><Input label="时间" type="time" value={dueTime} {...(error === null ? {} : { error })} onChange={(event) => { setDueTime(event.target.value); setError(null); }}/></Grid><SegmentedControl label="重复规则" value={repeat} onChange={setRepeat} options={[{ value: 'none', label: '一次' }, { value: 'daily', label: '每天' }]}/></LayoutSlot>
      <LayoutSlot as="section" variant="dialog-form-section"><Strong>播报行为</Strong><Switch label="启用提醒" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><Switch label="角色 TTS 播报" checked={allowTts} onChange={(event) => setAllowTts(event.target.checked)}/></LayoutSlot>
    </Stack>
  </Dialog>;
}
function formatDate(value: string): string { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function toLocalInput(value: string): string { const date = new Date(value); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
