import { Alert, Container, InlineText, ProductGrid, ProductMetric, ProductPage, ProductPanel, ProductStatusBar, ProductWorkspace, Strong } from "../../components/ui";
import { useCallback, useEffect, useState } from 'react';
import type { AgentConfirmationRequest } from '../../../shared/business';
import { Button } from '../../components/ui';
import { Textarea } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { bridge } from '../../shared/bridge';
export function AgentConfirmPage(): React.JSX.Element {
    const [request, setRequest] = useState<AgentConfirmationRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const load = useCallback(async (): Promise<void> => {
        const response = await bridge.agentConfirmation.get();
        if (response.success) {
            setRequest(response.payload);
            setBusy(false);
            setError('');
        }
        else
            setError(response.error?.message ?? '确认请求读取失败。');
    }, []);
    useEffect(() => {
        void load();
        window.addEventListener('focus', load);
        return () => window.removeEventListener('focus', load);
    }, [load]);
    async function finish(approved: boolean): Promise<void> {
        if (request === null || busy)
            return;
        setBusy(true);
        const response = await bridge.agentConfirmation.resolve(request.requestId, approved);
        if (!response.success || response.payload?.resolved !== true) {
            setError(response.error?.message ?? '确认请求已失效。');
            setBusy(false);
        }
    }
    return <ProductPage>
    <WindowTitleBar title="确认执行"/>
    <ProductWorkspace layout="center">
      <ProductPanel title={request?.capabilityName ?? '等待确认请求'} description={request?.displayName ?? '正在读取需要确认的能力。'} footer={<ProductStatusBar actions={<><Button disabled={request === null || busy} onClick={() => void finish(false)}>取消</Button><Button variant="primary" loading={busy} disabled={request === null} onClick={() => void finish(true)}>继续执行</Button></>}>{request === null ? '暂无待确认请求' : '等待你的确认'}</ProductStatusBar>} scroll emphasis>
        <Container>
          <Alert tone="warning" title="请确认执行范围">继续后将按下方参数执行该能力。</Alert>
          <ProductGrid density="metrics"><ProductMetric label="风险等级" value={request?.riskLevel || '—'}/><ProductMetric label="执行器类型" value={request?.executorType || '—'}/></ProductGrid>
          <Field label="说明" value={request?.summary ?? ''}/>
          <Container><Strong>执行参数</Strong><Textarea rows={3} readOnly value={request?.argsJson ?? '{}'}/></Container>
          {error !== '' ? <Alert tone="error" title="无法继续">{error}</Alert> : null}
        </Container>
      </ProductPanel>
    </ProductWorkspace>
  </ProductPage>;
}
function Field({ label, value, accent = false }: {
    label: string;
    value: string;
    accent?: boolean;
}): React.JSX.Element {
    return <Container><Strong>{label}</Strong>{accent ? <Strong>{value || '—'}</Strong> : <InlineText>{value || '—'}</InlineText>}</Container>;
}
