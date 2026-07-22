import { ExternalWebview, Paragraph, ProductPage, ProductPanel, ProductStatusBar, ProductWorkspace } from "../../components/ui";
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { bridge } from '../../shared/bridge';
export function DouyinLoginPage(): React.JSX.Element {
    const [status, setStatus] = useState('正在启动 App 专用浏览器…');
    const [ready, setReady] = useState(false);
    const [saving, setSaving] = useState(false);
    const webview = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const node = webview.current;
        if (node === null)
            return;
        const started = (): void => { setReady(false); setStatus('正在打开抖音…'); };
        const stopped = (): void => { setReady(true); setStatus('页面已打开。完成登录/验证并确认页面可用后保存会话。'); };
        const failed = (): void => { setReady(false); setStatus('抖音页面加载失败，请检查网络后重试。'); };
        node.addEventListener('did-start-loading', started);
        node.addEventListener('did-stop-loading', stopped);
        node.addEventListener('did-fail-load', failed);
        return () => { node.removeEventListener('did-start-loading', started); node.removeEventListener('did-stop-loading', stopped); node.removeEventListener('did-fail-load', failed); };
    }, []);
    return <ProductPage>
    <WindowTitleBar title="登录/刷新抖音会话"/>
    <ProductWorkspace layout="single">
      <ProductPanel title="抖音登录页面" scroll emphasis>
        <ExternalWebview ref={webview} source="https://www.douyin.com/" partition="persist:aimaid-douyin" label="抖音登录页面"/>
      </ProductPanel>
      <ProductStatusBar actions={<><Button disabled={saving} onClick={() => void bridge.window.close()}>暂不保存</Button><Button variant="primary" disabled={!ready || saving} onClick={() => void save(setStatus, setSaving)}>保存会话并关闭</Button></>}><Paragraph>{status}</Paragraph></ProductStatusBar>
    </ProductWorkspace>
  </ProductPage>;
}
async function save(setStatus: (value: string) => void, setSaving: (value: boolean) => void): Promise<void> {
    setSaving(true);
    setStatus('正在保存会话状态…');
    const response = await bridge.douyin.saveSession();
    if (!response.success) {
        setSaving(false);
        setStatus('保存会话失败：' + (response.error?.message ?? '未知错误'));
        return;
    }
    void bridge.window.close();
}
