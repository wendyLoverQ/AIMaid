import { Button, Container, Divider, Text, TrayMenuSurface } from "../../components/ui";
import { useEffect, useRef, useState } from 'react';
import { Range } from '../../components/ui';
import { bridge } from '../../shared/bridge';
interface MasterAudioState {
    muted: boolean;
    volume: number;
}
export function TrayMenuPage(): React.JSX.Element {
    const safeAudio: MasterAudioState = { muted: true, volume: 0 };
    const confirmedAudio = useRef(safeAudio);
    const [audio, setAudio] = useState<MasterAudioState>(safeAudio);
    const [error, setError] = useState('');
    useEffect(() => { void loadMasterAudio().then((loaded) => { confirmedAudio.current = loaded; setAudio(loaded); }).catch((reason: unknown) => setError(messageOf(reason, '主音量设置读取失败。'))); }, []);
    const save = async (next: MasterAudioState): Promise<void> => {
        const normalized = { muted: next.muted || next.volume <= 0, volume: next.volume };
        const response = await bridge.core.invoke({
            type: 'settings.save',
            payload: { values: { master_audio_muted: String(normalized.muted), master_audio_volume: String(normalized.volume) } }
        });
        if (response.success) {
            confirmedAudio.current = normalized;
            setAudio(normalized);
            setError('');
        } else {
            setAudio(confirmedAudio.current);
            setError(response.error?.message ?? '主音量设置保存失败。');
        }
    };
    const run = async (action: 'show' | 'reset-position' | 'hide' | 'quit'): Promise<void> => {
        const response = await bridge.tray.action(action);
        if (!response.success) setError(response.error?.message ?? '托盘操作失败。');
    };
    const openShowcase = async (): Promise<void> => {
        const response = await bridge.window.open('ui-showcase');
        if (!response.success) { setError(response.error?.message ?? '控件展示窗口打开失败。'); return; }
        await bridge.window.close();
    };
    return <TrayMenuSurface onKeyDown={(event) => { if (event.key === 'Escape')
        void bridge.window.close(); }} tabIndex={-1}>
    <Button onClick={() => run('show')}>显示</Button>
    <Divider />
    <Button variant={audio.muted ? 'primary' : 'secondary'} onClick={() => void save({ ...audio, muted: !audio.muted })}>
      {audio.muted ? '声音：已静音' : '声音：正常'}
    </Button>
    <Container>
      <Range label="主音量" valueLabel={`${audio.volume}%`} min="0" max="100" step="1" value={audio.volume} onChange={(event) => setAudio({ muted: Number(event.target.value) <= 0, volume: Number(event.target.value) })} onPointerUp={(event) => { const volume = Number(event.currentTarget.value); void save({ muted: volume <= 0, volume }); }} onKeyUp={(event) => { const volume = Number(event.currentTarget.value); void save({ muted: volume <= 0, volume }); }}/>
    </Container>
    {error !== '' ? <Text size="xs" tone="danger">{error}</Text> : null}
    <Divider />
    <Button onClick={() => void openShowcase()}>控件展示</Button>
    <Divider />
    <Button onClick={() => run('reset-position')}>位置回归</Button>
    <Button onClick={() => run('hide')}>隐藏</Button>
    <Button variant="danger" onClick={() => run('quit')}>退出</Button>
  </TrayMenuSurface>;
}
async function loadMasterAudio(): Promise<MasterAudioState> {
    const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys: ['master_audio_muted', 'master_audio_volume'] } });
    if (!response.success)
        throw new Error(response.error?.message ?? '主音量设置读取失败。');
    const payload = response.payload as {
        settings?: Array<{
            key: string;
            value: string;
        }>;
    } | null;
    const settings = new Map(payload?.settings?.map((item) => [item.key, item.value]));
    const volume = Math.min(100, Math.max(0, Number.parseInt(settings.get('master_audio_volume') ?? '100', 10) || 0));
    return { muted: settings.get('master_audio_muted')?.toLowerCase() === 'true' || volume <= 0, volume };
}
function messageOf(reason: unknown, fallback: string): string { return reason instanceof Error && reason.message.trim() !== '' ? reason.message : fallback; }
