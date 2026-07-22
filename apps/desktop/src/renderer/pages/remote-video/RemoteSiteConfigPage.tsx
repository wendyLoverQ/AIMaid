import { CodeBlock, Container, InlineText, Paragraph, ProductGrid, ProductList, ProductPage, ProductPanel, ProductSidebar, ProductStatusBar, ProductWorkspace, SettingsSection, Strong } from "../../components/ui";
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { Pressable } from '../../components/ui';
import { Input } from '../../components/ui';
import { Switch } from '../../components/ui';
import { Textarea } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { Dialog } from '../../components/ui';
import { bridge } from '../../shared/bridge';
import type { RemoteSiteDetailDto, RemoteSiteDto } from '../../../shared/business';
export function RemoteSiteConfigPage(): React.JSX.Element {
    const [cookieVisible, setCookieVisible] = useState(false);
    const [enabled, setEnabled] = useState(true);
    const [sessionStatus, setSessionStatus] = useState('未检查');
    const [diagnosis, setDiagnosis] = useState('');
    const [confirmClear, setConfirmClear] = useState(false);
    const [items, setItems] = useState<RemoteSiteDto[]>([]);
    const [siteId, setSiteId] = useState('');
    const [siteName, setSiteName] = useState('');
    const [domainPattern, setDomainPattern] = useState('');
    const [userAgent, setUserAgent] = useState('');
    const [referer, setReferer] = useState('');
    const [cookie, setCookie] = useState('');
    const [cookieDirty, setCookieDirty] = useState(false);
    const [hasCookie, setHasCookie] = useState(false);
    const [notes, setNotes] = useState('');
    const [message, setMessage] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const canSave = siteName.trim() !== '' && domainPattern.trim() !== '';
    const openDouyin = (): void => { void bridge.window.open('douyin-login'); };
    async function diagnose(): Promise<void> {
        setSessionStatus('正在检查…');
        const response = await bridge.douyin.inspectSession();
        if (!response.success || response.payload === null) {
            setSessionStatus('检查失败');
            setDiagnosis(response.error?.message ?? '未知错误');
            return;
        }
        const value = response.payload;
        setSessionStatus(value.hasSession ? '已存在登录会话' : value.cookieCount > 0 ? '已有 Cookie，未检测到 sessionid' : '未登录');
        setDiagnosis(JSON.stringify(value, null, 2));
    }
    async function clearSession(): Promise<void> {
        const response = await bridge.douyin.clearSession();
        setConfirmClear(false);
        if (!response.success) {
            setDiagnosis('清除失败：' + (response.error?.message ?? '未知错误'));
            return;
        }
        setSessionStatus('未登录');
        setDiagnosis('APP 抖音会话已清除。');
    }
    useEffect(() => { void diagnose(); void reloadSites(); }, []);
    async function reloadSites(preferredId?: string): Promise<void> {
        const response = await bridge.core.invoke({ type: 'remote_site.list', payload: { enabledOnly: false } });
        const values = response.success && Array.isArray(response.payload) ? response.payload as RemoteSiteDto[] : [];
        setItems(values);
        const selected = values.find((item) => item.siteId === preferredId) ?? values[0];
        if (selected !== undefined)
            await selectSite(selected.siteId);
        else
            newSite();
    }
    async function selectSite(id: string): Promise<void> {
        const response = await bridge.core.invoke({ type: 'remote_site.get', payload: { siteId: id } });
        if (!response.success || !isRemoteSiteDetail(response.payload))
            return;
        const detail = response.payload;
        let settings: {
            userAgent?: string;
            referer?: string;
            notes?: string;
        } = {};
        try {
            settings = JSON.parse(detail.site.settingsJson) as typeof settings;
        }
        catch {
            settings = {};
        }
        setSiteId(detail.site.siteId);
        setSiteName(detail.site.siteName);
        setDomainPattern(detail.site.domainPattern);
        setEnabled(detail.site.isEnabled);
        setUserAgent(settings.userAgent ?? '');
        setReferer(settings.referer ?? '');
        setNotes(settings.notes ?? '');
        setCookie('');
        setCookieDirty(false);
        setHasCookie(detail.site.hasProtectedCookie);
        setMessage('');
    }
    function newSite(): void { setSiteId(''); setSiteName(''); setDomainPattern(''); setEnabled(true); setUserAgent(''); setReferer(''); setCookie(''); setCookieDirty(false); setHasCookie(false); setNotes(''); setMessage(''); }
    async function saveSite(): Promise<void> {
        if (siteName.trim() === '' || domainPattern.trim() === '') {
            setMessage('站点名称和域名匹配不能为空。');
            return;
        }
        const id = siteId || `site_${crypto.randomUUID().replaceAll('-', '')}`;
        const site: RemoteSiteDto = { siteId: id, siteName: siteName.trim(), domainPattern: domainPattern.trim(), adapterKey: '', qualityPreference: '', isEnabled: enabled, settingsJson: JSON.stringify({ userAgent, referer, notes }), updatedAt: new Date().toISOString(), hasProtectedCookie: hasCookie };
        const response = await bridge.core.invoke({ type: 'remote_site.save', payload: { site, plainCookie: cookieDirty ? cookie : null } });
        if (!response.success) {
            setMessage(response.error?.message ?? '保存失败。');
            return;
        }
        setHasCookie(cookieDirty ? cookie.trim() !== '' : hasCookie);
        setCookie('');
        setCookieDirty(false);
        await reloadSites(id);
        setMessage('已保存。');
    }
    async function deleteSite(): Promise<void> {
        if (siteId === '') return;
        const response = await bridge.core.invoke({ type: 'remote_site.delete', payload: { siteId } });
        if (!response.success) {
            setConfirmDelete(false);
            setMessage(response.error?.message ?? '删除失败，请重试。');
            return;
        }
        setConfirmDelete(false);
        await reloadSites();
        setMessage('站点配置已删除。');
    }
    const tools = <Button size="sm" onClick={openDouyin}>抖音接入</Button>;
    return <ProductPage>
    <WindowTitleBar title="站点配置" tools={tools}/>
    <ProductWorkspace layout="sidebar">
      <ProductSidebar title="站点列表" actions={<Button size="sm" variant="primary" onClick={newSite}>新建</Button>}>
        {items.length === 0 ? <Container>暂无站点配置</Container> : <ProductList>{items.map((item) => <Pressable appearance="navigation" selected={item.siteId === siteId} key={item.siteId} onClick={() => void selectSite(item.siteId)}><Strong>{item.siteName}</Strong><InlineText>{item.domainPattern}</InlineText></Pressable>)}</ProductList>}
      </ProductSidebar>
      <ProductPanel title="配置详情" footer={<ProductStatusBar actions={<><Button variant="danger" disabled={siteId === ''} onClick={() => setConfirmDelete(true)}>删除</Button><Button variant="primary" disabled={!canSave} onClick={() => void saveSite()}>保存配置</Button></>}>{message}</ProductStatusBar>} scroll emphasis>
        <Container>
          <ConfigSection title="基础匹配">
            <Container><Input label="站点名称" value={siteName} onChange={(event) => setSiteName(event.target.value)}/><Input label="域名匹配" value={domainPattern} onChange={(event) => setDomainPattern(event.target.value)}/></Container>
            <Switch label="启用站点配置" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/>
          </ConfigSection>
          <ConfigSection title="请求身份">
            <Input label="User-Agent" value={userAgent} onChange={(event) => setUserAgent(event.target.value)}/>
            <Input label="Referer" value={referer} onChange={(event) => setReferer(event.target.value)}/>
          </ConfigSection>
          <ConfigSection title="抖音会话">
            <Strong>抖音会话状态：{sessionStatus}</Strong><ProductGrid density="actions"><Button onClick={openDouyin}>登录/刷新会话</Button><Button onClick={() => void diagnose()}>诊断会话</Button><Button onClick={() => setConfirmClear(true)}>清除 APP 会话</Button></ProductGrid><Paragraph>诊断只显示 Cookie 数量和关键字段是否存在，不显示 Cookie 内容。</Paragraph>{diagnosis !== '' ? <CodeBlock>{diagnosis}</CodeBlock> : null}
          </ConfigSection>
          <ConfigSection title="Cookie">
            <Paragraph>{cookieDirty ? cookie.trim() === '' ? '保存后会清除现有 Cookie。' : '已填写新 Cookie，保存后会替换现有内容。' : hasCookie ? '已安全保存 Cookie；出于安全考虑不会回显明文。' : '尚未保存 Cookie。'}</Paragraph><ProductGrid density="actions"><Button onClick={() => setCookieVisible((value) => !value)}>{cookieVisible ? '隐藏输入' : '输入新 Cookie'}</Button><Button onClick={() => void navigator.clipboard.readText().then((value) => { setCookie(value); setCookieDirty(true); setCookieVisible(true); }).catch(() => setMessage('无法读取剪贴板，请手动输入 Cookie。'))}>粘贴</Button><Button disabled={!hasCookie && !cookieDirty} onClick={() => { setCookie(''); setCookieDirty(true); setCookieVisible(false); }}>清除已保存 Cookie</Button><Button onClick={() => setMessage(!cookieDirty ? 'Cookie 未修改，将保留现有内容。' : cookie.trim() === '' ? '保存后会清除 Cookie。' : '新 Cookie 已填写，保存后会加密替换。')}>校验</Button></ProductGrid>
            {cookieVisible ? <Textarea aria-label="Cookie" rows={8} value={cookie} onChange={(event) => { setCookie(event.target.value); setCookieDirty(true); }}/> : null}
          </ConfigSection>
          <ConfigSection title="备注"><Textarea aria-label="备注" rows={4} value={notes} onChange={(event) => setNotes(event.target.value)}/></ConfigSection>
        </Container>
      </ProductPanel>
    </ProductWorkspace>
    <Dialog open={confirmClear} title="抖音会话" description="清除女仆助手的抖音专用会话？这不会影响系统 Chrome 或 Edge 的登录状态。" onClose={() => setConfirmClear(false)} footer={<><Button onClick={() => setConfirmClear(false)}>取消</Button><Button variant="danger" onClick={() => void clearSession()}>清除</Button></>}><Paragraph>只会删除 `persist:aimaid-douyin` 独立分区中的 Cookie 和站点存储。</Paragraph></Dialog>
    <Dialog open={confirmDelete} title="删除站点配置" description={`确认删除 ${siteName || '这个站点配置'}？`} onClose={() => setConfirmDelete(false)} footer={<><Button onClick={() => setConfirmDelete(false)}>取消</Button><Button variant="danger" onClick={() => void deleteSite()}>删除</Button></>}><Paragraph>站点设置和安全存储的 Cookie 会一起删除。</Paragraph></Dialog>
  </ProductPage>;
}
function isRemoteSiteDetail(value: unknown): value is RemoteSiteDetailDto { return typeof value === 'object' && value !== null && 'site' in value && typeof value.site === 'object' && value.site !== null; }
function ConfigSection({ title, children }: {
    title: string;
    children: React.ReactNode;
}): React.JSX.Element {
    return <SettingsSection title={title}><Container>{children}</Container></SettingsSection>;
}
