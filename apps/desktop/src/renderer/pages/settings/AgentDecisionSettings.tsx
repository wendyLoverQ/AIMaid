import { useEffect, useState } from 'react'
import { Accordion, Button, Container, Input, Paragraph, Select, SettingRow, Switch, Textarea, useToast } from '../../components/ui'
import type { AgentCapabilityDto } from '../../../shared/business'
import { bridge } from '../../shared/bridge'

export function AgentDecisionSettings(): React.JSX.Element {
  const toast = useToast()
  const [items, setItems] = useState<AgentCapabilityDto[] | null>(null)
  const [saving, setSaving] = useState('')

  useEffect(() => {
    void bridge.core.invoke({ type: 'agent.capabilities.list', payload: { enabledOnly: false } }).then((response) => {
      if (!response.success || !Array.isArray(response.payload))
        throw new Error(response.error?.message ?? 'Agent 能力读取失败。')
      setItems(response.payload as AgentCapabilityDto[])
    }).catch((reason: unknown) => toast.show(messageOf(reason), 'error'))
  }, [])

  function update(capabilityName: string, patch: Partial<AgentCapabilityDto>): void {
    setItems((current) => current?.map((item) => item.capabilityName === capabilityName ? { ...item, ...patch } : item) ?? null)
  }

  async function save(item: AgentCapabilityDto): Promise<void> {
    setSaving(item.capabilityName)
    try {
      const response = await bridge.core.invoke({ type: 'agent.capability.save', payload: { capability: item } })
      if (!response.success)
        throw new Error(response.error?.message ?? 'Agent 能力保存失败。')
      toast.show(`${item.displayName} 已保存到数据库，下一次 Agent 决策立即生效。`, 'success')
    } catch (reason) {
      toast.show(messageOf(reason), 'error')
    } finally {
      setSaving('')
    }
  }

  if (items === null)
    return <SettingCard title="Agent 工具能力"><Paragraph>正在读取数据库配置…</Paragraph></SettingCard>

  return <>
    <SettingCard title={`Agent 工具能力：${items.filter((item) => item.enabled).length} / ${items.length} 已启用`} description="Agent 只会把已启用能力交给模型。能力标识和执行器由代码绑定，不可在此修改。">
      <Paragraph>开关、确认策略、结果处理、风险、排序和执行参数均保存在 AgentCapabilities 数据表。</Paragraph>
    </SettingCard>
    {items.map((item) => <Accordion key={item.capabilityName} title={`${item.displayName} · ${item.enabled ? '已启用' : '已停用'}`}>
      <SettingCard title={item.capabilityName} description={`执行器：${item.executorType}`}>
        <Switch label="允许 Agent 调用" checked={item.enabled} onChange={(event) => update(item.capabilityName, { enabled: event.target.checked })}/>
        <Switch label="执行前要求用户确认" checked={item.requireConfirm} onChange={(event) => update(item.capabilityName, { requireConfirm: event.target.checked })}/>
        <Input label="显示名称" value={item.displayName} onChange={(event) => update(item.capabilityName, { displayName: event.target.value })}/>
        <Textarea label="给 Agent 的能力说明" rows={3} value={item.description} onChange={(event) => update(item.capabilityName, { description: event.target.value })}/>
        <Select label="结果处理策略" value={item.resultPolicy} onChange={(event) => update(item.capabilityName, { resultPolicy: event.target.value })} options={[
          { value: 'silent', label: 'silent · 不播报工具结果' },
          { value: 'simple_status', label: 'simple_status · 简要状态' },
          { value: 'raw', label: 'raw · 原始结果' },
          { value: 'llm_summarize_on_error', label: 'llm_summarize_on_error · 失败时总结' },
          { value: 'llm_summarize_always', label: 'llm_summarize_always · 始终总结' }
        ]}/>
        <Select label="风险等级" value={item.riskLevel} onChange={(event) => update(item.capabilityName, { riskLevel: event.target.value })} options={[
          { value: 'low', label: '低' }, { value: 'medium', label: '中' },
          { value: 'high', label: '高' }, { value: 'critical', label: '严重' }
        ]}/>
        <Input label="排序" type="number" value={String(item.sortOrder)} onChange={(event) => update(item.capabilityName, { sortOrder: Number(event.target.value) })}/>
      </SettingCard>
      <Accordion title="执行配置（高级）">
        <SettingCard title="执行器配置" description="配置会传给代码中的固定执行器；无效 JSON 会被 Core 拒绝。">
          <Textarea label="Config JSON" rows={7} value={item.configJson} onChange={(event) => update(item.capabilityName, { configJson: event.target.value })}/>
          <Textarea label="参数 JSON Schema" rows={7} value={item.argsSchemaJson} onChange={(event) => update(item.capabilityName, { argsSchemaJson: event.target.value })}/>
        </SettingCard>
      </Accordion>
      <Button variant="primary" loading={saving === item.capabilityName} disabled={saving !== ''} onClick={() => void save(item)}>保存此能力</Button>
    </Accordion>)}
  </>
}

function SettingCard({ title, description, children }: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return <SettingRow title={title} {...(description === undefined ? {} : { description })} control={<Container>{children}</Container>} />
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
