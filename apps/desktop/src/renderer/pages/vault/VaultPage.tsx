import { Container, Emphasis, FormLabel, Header, InlineText, LayoutSlot, Paragraph, ProductList, ProductPage, ProductPanel, ProductSidebar, ProductStatusBar, ProductToolbar, ProductWorkspace, Section, SmallText, Strong, Title3 } from "../../components/ui";
import { useEffect, useMemo, useState } from 'react';
import type { VaultHistoryDto, VaultItemDetailDto, VaultItemDto } from '../../../shared/business';
import { Button } from '../../components/ui';
import { Pressable } from '../../components/ui';
import { Input } from '../../components/ui';
import { Select } from '../../components/ui';
import { Textarea } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { Dialog } from '../../components/ui';
import { bridge } from '../../shared/bridge';
type VaultType = 'Login' | 'Wallet' | 'ApiKey' | 'Server';
const TYPES = [
    { value: 'All', label: '全部类型' }, { value: 'Login', label: '登录密码' },
    { value: 'Wallet', label: '钱包' }, { value: 'ApiKey', label: 'API Key' }, { value: 'Server', label: '服务器' }
];
const FIELDS: Record<VaultType, readonly [
    string,
    boolean
][]> = {
    Login: [['名称', false], ['账号', false], ['密码', true], ['网址', false], ['分类', false], ['备注', false]],
    Wallet: [['名称', false], ['链类型', false], ['钱包地址', false], ['私钥', true], ['助记词', true], ['备注', false]],
    ApiKey: [['名称', false], ['平台', false], ['API Key', true], ['Secret', true], ['备注', false]],
    Server: [['名称', false], ['地址', false], ['端口', false], ['账号', false], ['密码', true], ['备注', false]]
};
export function VaultPage(): React.JSX.Element {
    const [items, setItems] = useState<VaultItemDto[]>([]);
    const [currentId, setCurrentId] = useState<string | null>(null);
    const [createdAt, setCreatedAt] = useState('');
    const [updatedAt, setUpdatedAt] = useState('');
    const [type, setType] = useState<VaultType>('Login');
    const [typeFilter, setTypeFilter] = useState('All');
    const [query, setQuery] = useState('');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [histories, setHistories] = useState<VaultHistoryDto[]>([]);
    const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [exportStatus, setExportStatus] = useState('');
    const [values, setValues] = useState<Record<string, string>>(createDraft);
    const [warning, setWarning] = useState('');
    const [toast, setToast] = useState('');
    const fields = useMemo(() => FIELDS[type], [type]);
    async function load(selectId?: string | null): Promise<void> {
        const response = await bridge.core.invoke({ type: 'vault.list', payload: {} });
        if (!response.success || !Array.isArray(response.payload)) {
            setExportStatus(response.error?.message ?? '密码库读取失败。');
            return;
        }
        const next = response.payload.filter(isVaultItem);
        setItems(next);
        const targetId = selectId === null ? next[0]?.itemId : selectId ?? currentId ?? next[0]?.itemId;
        if (targetId !== undefined)
            await selectItem(targetId);
        else
            showDraft();
    }
    useEffect(() => { void load(); }, []);
    async function selectItem(itemId: string): Promise<void> {
        const response = await bridge.core.invoke({ type: 'vault.secret.reveal', payload: { itemId } });
        if (!response.success || !isVaultDetail(response.payload)) {
            setExportStatus(response.error?.message ?? '密码库条目读取失败。');
            return;
        }
        const detail = response.payload;
        const metadata = parseRecord(detail.item.publicMetadataJson);
        const secrets = parseRecord(detail.secret ?? '');
        setCurrentId(detail.item.itemId);
        setCreatedAt(detail.item.createdAt);
        setUpdatedAt(detail.item.updatedAt);
        setType(isVaultType(detail.item.itemType) ? detail.item.itemType : 'Login');
        setValues({
            名称: detail.item.name, 分类: detail.item.category, 账号: detail.item.account, 网址: detail.item.url, 平台: detail.item.platform,
            备注: metadata.Remark ?? '', 链类型: metadata.ChainType ?? '', 钱包地址: metadata.WalletAddress ?? '', 地址: metadata.ServerAddress ?? '', 端口: metadata.ServerPort ?? '',
            密码: secrets.Password ?? '', 'API Key': secrets.ApiKey ?? '', Secret: secrets.Secret ?? '', 私钥: secrets.PrivateKey ?? '', 助记词: secrets.Mnemonic ?? ''
        });
    }
    function showDraft(): void {
        setCurrentId(null);
        setCreatedAt('');
        setUpdatedAt('');
        setType('Login');
        setValues(createDraft());
        setHistoryOpen(false);
    }
    function add(): void {
        showDraft();
        setWarning('');
        setExportStatus('');
    }
    async function save(): Promise<void> {
        if ((values['名称'] ?? '').trim() === '') {
            setWarning('名称不能为空。');
            return;
        }
        const now = new Date().toISOString();
        const itemId = currentId ?? '';
        const response = await bridge.core.invoke({ type: 'vault.save', payload: { item: makeDto(itemId, type, values, createdAt || now, now), plainSecret: encodeSecrets(values) } });
        if (!response.success) {
            setExportStatus(response.error?.message ?? '密码库保存失败。');
            return;
        }
        const savedId = typeof response.payload === 'string' ? response.payload : itemId;
        await load(savedId);
    }
    async function remove(): Promise<void> {
        if (currentId === null)
            return;
        const response = await bridge.core.invoke({ type: 'vault.delete', payload: { itemId: currentId } });
        if (!response.success) {
            setExportStatus(response.error?.message ?? '删除条目失败。');
            return;
        }
        setDeleteOpen(false);
        setCurrentId(null);
        await load(null);
    }
    async function exportVault(): Promise<void> {
        const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 15);
        const response = await bridge.dialog.saveFile(`AI_Maid_Vault_${stamp}.7z`, [{ name: '7z 加密压缩包', extensions: ['7z'] }]);
        if (!response.success) {
            setExportStatus(response.error?.message ?? '导出位置选择失败。');
            return;
        }
        if (response.payload?.canceled || response.payload?.filePath === undefined)
            return;
        const exported = await bridge.core.invoke({ type: 'vault.export', payload: { outputPath: response.payload.filePath } }, 120000);
        setExportStatus(exported.success ? '导出完成。' : exported.error?.message ?? '导出失败。');
    }
    async function openHistory(): Promise<void> {
        if (currentId === null)
            return;
        const response = await bridge.core.invoke({ type: 'vault.history.list', payload: { itemId: currentId } });
        if (!response.success || !Array.isArray(response.payload)) {
            setExportStatus(response.error?.message ?? '历史记录读取失败。');
            return;
        }
        const next = response.payload.filter(isVaultHistory);
        setHistories(next);
        setSelectedHistoryId(next[0]?.historyId ?? null);
        setHistoryOpen(true);
    }
    async function restoreHistory(): Promise<void> {
        if (selectedHistoryId === null || currentId === null)
            return;
        const response = await bridge.core.invoke({ type: 'vault.history.restore', payload: { historyId: selectedHistoryId } });
        if (!response.success) {
            setExportStatus(response.error?.message ?? '恢复历史记录失败。');
            return;
        }
        setHistoryOpen(false);
        await load(currentId);
    }
    const copy = async (label: string): Promise<void> => {
        try {
            await navigator.clipboard.writeText(values[label] ?? '');
            setToast('已复制');
        }
        catch {
            setToast('复制失败');
        }
        window.setTimeout(() => setToast(''), 800);
    };
    const filtered = items.filter((item) => {
        if (typeFilter !== 'All' && item.itemType !== typeFilter)
            return false;
        const text = query.trim().toLocaleLowerCase();
        if (text === '')
            return true;
        const metadata = parseRecord(item.publicMetadataJson);
        return [item.name, item.account, item.platform, item.url, item.category, metadata.Remark, metadata.WalletAddress, metadata.ServerAddress]
            .some((value) => (value ?? '').toLocaleLowerCase().includes(text));
    });
    return <ProductPage>
    <WindowTitleBar title="密码库" tools={<Button size="sm" onClick={() => void exportVault()}>导出</Button>}/>
    <ProductWorkspace layout="sidebar">
      <ProductSidebar title="条目列表" description={`${filtered.length}/${items.length} 个条目`} actions={<Button size="sm" variant="primary" onClick={add}>新增</Button>}>
        <ProductToolbar layout="stacked" lead={<Input aria-label="搜索密码库" value={query} onChange={(event) => setQuery(event.target.value)}/>} actions={<Select aria-label="条目类型" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} options={TYPES}/>}/>
        <ProductList>{filtered.length === 0 ? <Container>没有匹配的条目</Container> : filtered.map((item) => <Pressable selected={currentId === item.itemId} key={item.itemId} onClick={() => void selectItem(item.itemId)}><Strong>{item.name}</Strong><InlineText>{listSubtitle(item)}</InlineText><SmallText>{item.category || '未分类'} · {formatListTime(item.updatedAt)} <Emphasis>{typeLabel(item.itemType)}</Emphasis></SmallText></Pressable>)}</ProductList>
      </ProductSidebar>
      <ProductPanel title={currentId === null ? '新建密码库条目' : values['名称']} description={`${typeLabel(type)} · ${currentId === null ? '尚未保存' : `更新于 ${formatDetailTime(updatedAt)}`}`} actions={<><Button disabled={currentId === null} onClick={() => void openHistory()}>历史记录</Button><Button variant="danger" disabled={currentId === null} onClick={() => setDeleteOpen(true)}>删除</Button><Button variant="primary" onClick={() => void save()}>保存</Button></>} scroll emphasis>
        <Section><Title3>基础信息</Title3>
          <FormLabel><InlineText>条目类型</InlineText><Select value={type} onChange={(event) => setType(event.target.value as VaultType)} options={TYPES.slice(1)}/></FormLabel>
          {fields.map(([label, secret]) => {
            const multiline = label === '备注' || label === '助记词';
            const canCopy = secret || label === '账号' || label === '钱包地址' || label === '地址';
            return <FormLabel key={label}><InlineText>{label}</InlineText><LayoutSlot variant="vault-field-control">{multiline
                    ? <Textarea aria-label={label} rows={4} value={values[label] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [label]: event.target.value }))}/>
                    : <Input aria-label={label} type="text" value={values[label] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [label]: event.target.value }))}/>}{canCopy ? <Button disabled={(values[label] ?? '') === ''} onClick={() => void copy(label)}>复制</Button> : null}</LayoutSlot></FormLabel>;
        })}
        </Section>
      </ProductPanel>
      {exportStatus !== '' ? <ProductStatusBar>{exportStatus}</ProductStatusBar> : null}
    </ProductWorkspace>
    <Dialog open={historyOpen} title="历史记录" onClose={() => setHistoryOpen(false)} footer={<Button variant="primary" disabled={selectedHistoryId === null} onClick={() => void restoreHistory()}>恢复旧值</Button>}><Container><Header><InlineText>字段</InlineText><InlineText>备注</InlineText><InlineText>时间</InlineText></Header>{histories.length === 0 ? <Paragraph>暂无历史记录</Paragraph> : histories.map((history) => <Pressable selected={selectedHistoryId === history.historyId} key={history.historyId} onClick={() => setSelectedHistoryId(history.historyId)}><InlineText>{history.fieldName}</InlineText><InlineText>{history.changeRemark}</InlineText><InlineText>{formatDetailTime(history.createdAt)}</InlineText></Pressable>)}</Container></Dialog>
    <Dialog open={deleteOpen} title="删除条目" onClose={() => setDeleteOpen(false)} footer={<><Button onClick={() => setDeleteOpen(false)}>否</Button><Button variant="danger" onClick={() => void remove()}>是</Button></>}><Paragraph>确认删除 [{values['名称'] ?? ''}]？</Paragraph></Dialog>
    <Dialog open={warning !== ''} title="我的钱包" onClose={() => setWarning('')} footer={<Button variant="primary" onClick={() => setWarning('')}>确定</Button>}><Paragraph>{warning}</Paragraph></Dialog>
    {toast !== '' ? <Container>{toast}</Container> : null}
  </ProductPage>;
}
function createDraft(): Record<string, string> { return { 名称: '新条目', 分类: '常用' }; }
function typeLabel(type: string): string { return TYPES.find((item) => item.value === type)?.label ?? '登录密码'; }
function isVaultType(value: string): value is VaultType { return value === 'Login' || value === 'Wallet' || value === 'ApiKey' || value === 'Server'; }
function isVaultItem(value: unknown): value is VaultItemDto { return typeof value === 'object' && value !== null && 'itemId' in value && typeof value.itemId === 'string' && 'itemType' in value && typeof value.itemType === 'string' && 'name' in value && typeof value.name === 'string' && 'publicMetadataJson' in value && typeof value.publicMetadataJson === 'string'; }
function isVaultDetail(value: unknown): value is VaultItemDetailDto { return typeof value === 'object' && value !== null && 'item' in value && isVaultItem(value.item) && 'secret' in value && (value.secret === null || typeof value.secret === 'string'); }
function isVaultHistory(value: unknown): value is VaultHistoryDto { return typeof value === 'object' && value !== null && 'historyId' in value && typeof value.historyId === 'string' && 'itemId' in value && typeof value.itemId === 'string' && 'fieldName' in value && typeof value.fieldName === 'string' && 'changeRemark' in value && typeof value.changeRemark === 'string' && 'createdAt' in value && typeof value.createdAt === 'string'; }
function parseRecord(value: string): Record<string, string> { try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [
        string,
        string
    ] => typeof entry[1] === 'string')) : {};
}
catch {
    return {};
} }
function makeDto(itemId: string, itemType: VaultType, values: Record<string, string>, createdAt: string, updatedAt: string): VaultItemDto { return { itemId, itemType, name: values['名称'] ?? '', category: values['分类'] ?? '常用', account: values['账号'] ?? '', url: values['网址'] ?? '', platform: values['平台'] ?? '', publicMetadataJson: JSON.stringify({ Remark: values['备注'] ?? '', ChainType: values['链类型'] ?? '', WalletAddress: values['钱包地址'] ?? '', ServerAddress: values['地址'] ?? '', ServerPort: values['端口'] ?? '' }), hasProtectedSecret: true, createdAt, updatedAt }; }
function encodeSecrets(values: Record<string, string>): string { return JSON.stringify({ Password: values['密码'] ?? '', ApiKey: values['API Key'] ?? '', Secret: values.Secret ?? '', PrivateKey: values['私钥'] ?? '', Mnemonic: values['助记词'] ?? '' }); }
function listSubtitle(item: VaultItemDto): string { const metadata = parseRecord(item.publicMetadataJson); const value = item.itemType === 'Wallet' ? metadata.WalletAddress : item.itemType === 'ApiKey' ? item.platform : item.itemType === 'Server' ? metadata.ServerAddress : item.account; return value || '未填写账号或地址'; }
function formatListTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '--' : `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`; }
function formatDetailTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '--' : `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`; }
