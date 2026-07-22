import { Alert, Button, Dialog, FormField, Inline, Input, LayoutSlot, MediaImage, Page, PageContent, Select, Stack, Strong, Surface, Tabs, Text, Textarea, VisualRegion, WindowTitleBar } from '../../components/ui';
import { useEffect, useMemo, useState } from 'react';
import type { CharacterDto, RoleVoiceDto, VoiceAssetDto } from '../../../shared/business';
import { bridge } from '../../shared/bridge';
type Tab = '基础' | '音色' | '原角色卡';
export function CharacterEditorPage(): React.JSX.Element {
    const original = useMemo(readRole, []);
    const [tab, setTab] = useState<Tab>('基础');
    const [roleId, setRoleId] = useState(original?.roleId ?? '');
    const [name, setName] = useState(original?.name ?? '');
    const [avatar, setAvatar] = useState(original?.avatarPath ?? '');
    const [avatarUrl, setAvatarUrl] = useState('');
    const [voiceAssets, setVoiceAssets] = useState<VoiceAssetDto[]>([]);
    const [voiceId, setVoiceId] = useState(original?.preferredVoiceId ?? original?.voiceName ?? '');
    const [cardJson, setCardJson] = useState(formatJson(original?.sourceCardJson ?? ''));
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [voiceDialog, setVoiceDialog] = useState(false);
    const [voiceFolder, setVoiceFolder] = useState('');
    const [voiceStyle, setVoiceStyle] = useState('normal');
    const [voiceDisplayName, setVoiceDisplayName] = useState('');
    const [voiceDialogError, setVoiceDialogError] = useState('');
    const editing = original !== null;
    useEffect(() => { void loadVoiceAssets().then(setVoiceAssets).catch((reason: unknown) => setError(messageOf(reason))); }, []);
    useEffect(() => {
        if (avatar === '') {
            setAvatarUrl('');
            return;
        }
        void bridge.media.registerLocalFile(avatar).then((response) => setAvatarUrl(response.success ? response.payload?.url ?? '' : ''));
    }, [avatar]);
    function parseCard(): void {
        try {
            const card = JSON.parse(cardJson) as Record<string, unknown>;
            if (roleId.trim() === '' && typeof card.id === 'string')
                setRoleId(card.id);
            if (name.trim() === '' && typeof card.name === 'string')
                setName(card.name);
            setError('');
        }
        catch {
            setError('原角色卡 JSON 解析失败，请检查格式。');
        }
    }
    async function save(): Promise<void> {
        if (name.trim() === '') {
            setError('显示名称不能为空。');
            return;
        }
        if (voiceId.trim() === '') {
            setError('请选择一个角色音色。');
            return;
        }
        const id = roleId.trim() || name.trim();
        const now = new Date().toISOString();
        const character: CharacterDto = {
            roleId: id, name: name.trim(), voiceName: original?.voiceName ?? voiceId.trim(), roleTitle: original?.roleTitle ?? name.trim(),
            cardPath: original?.cardPath ?? '', sourceCardJson: cardJson.trim(), templateCardJson: original?.templateCardJson ?? '', preferredVoiceId: voiceId.trim(),
            validationStatus: original?.validationStatus ?? '', isEnabled: original?.isEnabled ?? true, updatedAt: now,
            cardSummary: original?.cardSummary ?? '', cardSchemaVersion: original?.cardSchemaVersion ?? '', templateCardSourceHash: original?.templateCardSourceHash ?? '',
            templateCardGenerationStatus: original?.templateCardGenerationStatus ?? '', templateCardGenerationMessage: original?.templateCardGenerationMessage ?? '',
            templateCardGeneratedAt: original?.templateCardGeneratedAt ?? null, templateCardLastAttemptAt: original?.templateCardLastAttemptAt ?? null,
            templateCardIterationCount: original?.templateCardIterationCount ?? 0, validationMessage: original?.validationMessage ?? '', lastValidatedAt: original?.lastValidatedAt ?? null,
            avatarPath: avatar
        };
        setSaving(true);
        const response = await bridge.core.invoke({ type: 'character.save', payload: { character } });
        setSaving(false);
        if (!response.success) {
            setError(response.error?.message ?? '角色保存失败。');
            return;
        }
        const voices = roleVoicesForSelection(voiceAssets, voiceId, id);
        const voiceResponse = await bridge.core.invoke({ type: 'character.voices.set', payload: { roleId: id, voices } });
        if (!voiceResponse.success) {
            setError(voiceResponse.error?.message ?? '角色音色绑定失败。');
            return;
        }
        void bridge.window.close();
    }
    async function browseAvatar(): Promise<void> {
        const response = await bridge.dialog.openFile([{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }]);
        const file = readFirstPath(response.payload);
        if (file === null)
            return;
        const imported = await bridge.core.invoke({ type: 'character.avatar.import', payload: { sourcePath: file } });
        if (!imported.success || typeof imported.payload !== 'string') {
            setError(imported.error?.message ?? '头像复制失败。');
            return;
        }
        setAvatar(imported.payload);
    }
    async function browseVoiceFolder(): Promise<void> {
        const response = await bridge.dialog.openDirectory();
        const file = response.success ? response.payload?.filePaths[0] : undefined;
        if (file === undefined)
            return;
        setVoiceFolder(file);
        if (voiceDisplayName.trim() === '')
            setVoiceDisplayName(buildVoiceId(file, voiceStyle));
        setVoiceDialogError('');
    }
    async function saveVoiceAsset(): Promise<void> {
        if (voiceFolder.trim() === '') {
            setVoiceDialogError('请选择音色文件夹。');
            return;
        }
        if (buildVoiceId(voiceFolder, voiceStyle) === '') {
            setVoiceDialogError('无法生成 voiceId，请检查文件夹名称。');
            return;
        }
        const baseName = voiceFolder.trim().replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? '';
        const response = await bridge.core.invoke({ type: 'character.voice_asset.add', payload: { baseName, displayName: voiceDisplayName.trim(), style: voiceStyle, sourceFolderPath: voiceFolder } });
        if (!response.success) {
            setVoiceDialogError(response.error?.message ?? '音色保存失败。');
            return;
        }
        const assets = await loadVoiceAssets();
        setVoiceAssets(assets);
        if (typeof response.payload === 'object' && response.payload !== null && 'voiceId' in response.payload && typeof response.payload.voiceId === 'string')
            setVoiceId(response.payload.voiceId);
        setVoiceDialog(false);
        setVoiceDialogError('');
    }
    const generatedVoiceId = buildVoiceId(voiceFolder, voiceStyle);
    return <Page>
    <WindowTitleBar title={editing ? '编辑语音角色' : '新增语音角色'} tools={<Inline><Button onClick={() => void bridge.window.close()}>取消</Button><Button variant="primary" loading={saving} onClick={() => void save()}>{editing ? '保存修改' : '创建角色'}</Button></Inline>}/>
    <PageContent>
      <LayoutSlot variant="character-editor-layout">
        <Surface variant="character-editor-preview">
          <Stack gap="md">
            <VisualRegion ratio="square">{avatarUrl !== '' ? <MediaImage src={avatarUrl} alt={`${name || '角色'}头像`}/> : <LayoutSlot as="span" variant="character-editor-placeholder">{name.trim().slice(0, 1) || '—'}</LayoutSlot>}</VisualRegion>
            <Stack gap="xs"><Strong>{name.trim() || (editing ? '角色资料' : '新角色')}</Strong><Text tone="muted">{roleId.trim() || '尚未设置角色 ID'}</Text></Stack>
            <FormField label="头像路径"><Input aria-label="头像路径" value={avatar} onChange={(event) => setAvatar(event.target.value)}/></FormField>
            <Button onClick={() => void browseAvatar()}>浏览头像</Button>
          </Stack>
        </Surface>
        <Surface variant="character-editor-form">
          <Tabs label="角色编辑分类" value={tab} onChange={(value) => setTab(value as Tab)} items={[{ id: '基础', label: '基础' }, { id: '音色', label: '音色' }, { id: '原角色卡', label: '角色卡' }]} />
          {error !== '' ? <Alert tone="error">{error}</Alert> : null}
          {tab === '基础' ? <Stack gap="lg"><Strong>基础信息</Strong><Input label="角色 ID" value={roleId} onChange={(event) => setRoleId(event.target.value)}/><Input label="显示名称" value={name} onChange={(event) => setName(event.target.value)}/></Stack> : null}
          {tab === '音色' ? <Stack gap="lg"><Strong>音色配置</Strong><Select label="角色音色" value={voiceId} onChange={(event) => setVoiceId(event.target.value)} options={[{ value: '', label: '请选择角色音色' }, ...voiceAssets.map((item) => ({ value: item.voiceId, label: `${item.displayName} · ${item.voiceId}` }))]}/><Button onClick={() => setVoiceDialog(true)}>新建音色</Button></Stack> : null}
          {tab === '原角色卡' ? <Stack gap="md"><Inline justify="between"><Strong>原角色卡</Strong><Button onClick={parseCard}>解析角色卡</Button></Inline><Textarea aria-label="原角色卡 JSON" value={cardJson} onChange={(event) => setCardJson(event.target.value)} rows={22}/></Stack> : null}
        </Surface>
      </LayoutSlot>
    </PageContent>
    <Dialog open={voiceDialog} title="新建音色" onClose={() => setVoiceDialog(false)} footer={<><Button onClick={() => setVoiceDialog(false)}>取消</Button><Button variant="primary" onClick={() => void saveVoiceAsset()}>保存</Button></>}>
      <Stack gap="md">
        <Stack gap="sm"><Input label="源文件夹" readOnly value={voiceFolder}/><Button onClick={() => void browseVoiceFolder()}>选择文件夹</Button></Stack>
        <Select label="音色类型" value={voiceStyle} onChange={(event) => setVoiceStyle(event.target.value)} options={['normal', 'soft', 'lively', 'close'].map((value) => ({ value, label: value }))}/>
        <Input label="显示名称" value={voiceDisplayName} onChange={(event) => setVoiceDisplayName(event.target.value)}/>
        <Input label="将生成 voiceId" readOnly value={generatedVoiceId}/>
        {voiceDialogError !== '' ? <Alert tone="error">{voiceDialogError}</Alert> : null}
      </Stack>
    </Dialog>
  </Page>;
}
async function loadVoiceAssets(): Promise<VoiceAssetDto[]> {
    const response = await bridge.core.invoke({ type: 'character.voice_assets', payload: {} });
    if (!response.success || !Array.isArray(response.payload))
        throw new Error(response.error?.message ?? '音色列表读取失败。');
    return response.payload as VoiceAssetDto[];
}
function roleVoicesForSelection(assets: readonly VoiceAssetDto[], selectedVoiceId: string, roleId: string): RoleVoiceDto[] {
    const base = selectedVoiceId.replace(/_(normal|soft|lively|close)$/iu, '');
    const matched = assets.filter((item) => item.voiceId.replace(/_(normal|soft|lively|close)$/iu, '') === base);
    const normal = matched.find((item) => item.voiceId.endsWith('_normal')) ?? assets.find((item) => item.voiceId === selectedVoiceId);
    const now = new Date().toISOString();
    return ['normal', 'soft', 'lively', 'close'].map((style, index) => {
        const asset = matched.find((item) => item.voiceId.endsWith(`_${style}`)) ?? normal;
        return asset === undefined ? null : { roleId, voiceId: asset.voiceId, style, isDefault: index === 0, isEnabled: true, updatedAt: now };
    }).filter((item): item is RoleVoiceDto => item !== null);
}
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
function readRole(): CharacterDto | null { try {
    const value = localStorage.getItem('aimaid.character-editor-role');
    return value === null ? null : JSON.parse(value) as CharacterDto;
}
catch {
    return null;
} }
function formatJson(value: string): string { if (value === '')
    return ''; try {
    return JSON.stringify(JSON.parse(value), null, 2);
}
catch {
    return value;
} }
function readFirstPath(value: unknown): string | null { if (typeof value !== 'object' || value === null || !('filePaths' in value) || !Array.isArray(value.filePaths))
    return null; return typeof value.filePaths[0] === 'string' ? value.filePaths[0] : null; }
function buildVoiceId(folder: string, style: string): string {
    const part = folder.trim().replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1)?.toLowerCase().replace(/\s+/gu, '_').replace(/[^\p{L}\p{N}_-]/gu, '') ?? '';
    const base = part.replace(/_(normal|soft|lively|close)$/iu, '').replace(/^[_-]+|[_-]+$/gu, '');
    return base === '' ? '' : `${base}_${style}`;
}
