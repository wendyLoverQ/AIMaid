import { Badge, Button, Dialog, EmptyState, Inline, LayoutSlot, Page, PageContent, Stack, Strong, Surface, Text, Textarea, WindowTitleBar } from '../../components/ui';
import { useMemo, useState } from 'react';
import type { CharacterDto } from '../../../shared/business';
import { bridge } from '../../shared/bridge';
export function TemplateCardPage(): React.JSX.Element {
    const initialRole = useMemo(readRole, []);
    const [role, setRole] = useState(initialRole);
    const [operation, setOperation] = useState<'重新生成' | '继续迭代' | null>(null);
    const [error, setError] = useState('');
    const generatedAt = formatDate(role?.templateCardGeneratedAt);
    const status = formatStatus(role?.templateCardGenerationStatus);
    const json = formatJson(role?.templateCardJson);
    return <Page>
    <WindowTitleBar title="当前角色卡"/>
    <PageContent>
      {role === null ? <EmptyState title="未找到角色" /> : <LayoutSlot variant="template-card-layout">
        <LayoutSlot as="header" variant="template-card-summary">
          <Stack gap="xs"><Inline><Strong>{role.name || role.roleId}</Strong><Badge tone={status === '已生成' ? 'success' : status === '生成失败' ? 'danger' : 'neutral'}>{status}</Badge></Inline><Text tone="secondary">角色 ID：{role.roleId} · 生成时间：{generatedAt}</Text>{role.templateCardGenerationMessage ? <Text tone="secondary">{role.templateCardGenerationMessage}</Text> : null}</Stack>
          <Inline><Strong>已迭代 {role.templateCardIterationCount} 次</Strong><Button variant="primary" loading={operation === '重新生成'} disabled={operation !== null} onClick={() => void generate(false)}>重新生成</Button><Button loading={operation === '继续迭代'} disabled={!role.templateCardJson || operation !== null} onClick={() => void generate(true)}>继续迭代</Button></Inline>
        </LayoutSlot>
        <Surface variant="template-card-reader"><Textarea aria-label="角色卡正文" readOnly rows={24} value={json || '当前角色卡尚未生成。'}/></Surface>
      </LayoutSlot>}
    </PageContent>
    <Dialog open={error !== ''} title={`${operation ?? '角色卡生成'}失败`} onClose={() => setError('')} footer={<Button variant="primary" onClick={() => setError('')}>确定</Button>}><Text as="p" wrap>{error}</Text></Dialog>
  </Page>;
    async function generate(continueIteration: boolean): Promise<void> {
        if (role === null)
            return;
        const name = continueIteration ? '继续迭代' : '重新生成';
        setOperation(name);
        setError('');
        const response = await bridge.core.invoke({ type: 'character.template.generate', payload: { roleId: role.roleId, continueIteration } }, 120000);
        if (response.success && response.payload !== null) {
            const refreshed = response.payload as CharacterDto;
            setRole(refreshed);
            localStorage.setItem('aimaid.template-card-role', JSON.stringify(refreshed));
        }
        else
            setError(response.error?.message ?? `未能读取${name}后的当前角色卡。`);
        setOperation(null);
    }
}
function readRole(): CharacterDto | null { try {
    const value = localStorage.getItem('aimaid.template-card-role');
    return value === null ? null : JSON.parse(value) as CharacterDto;
}
catch {
    return null;
} }
function formatDate(value: string | null | undefined): string { if (!value)
    return '尚未生成'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '尚未生成' : date.toLocaleString('zh-CN'); }
function formatStatus(value: string | undefined): string { switch (value?.toLowerCase()) {
    case 'ready':
    case 'completed': return '已生成';
    case 'generating': return '生成中';
    case 'failed': return '生成失败';
    default: return '尚未生成';
} }
function formatJson(value: string | undefined): string { if (!value)
    return ''; try {
    return JSON.stringify(JSON.parse(value), null, 2);
}
catch {
    return value;
} }
