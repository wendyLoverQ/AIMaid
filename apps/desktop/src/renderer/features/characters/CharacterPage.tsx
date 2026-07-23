import { useEffect, useMemo, useState } from 'react'
import type { CharacterDto, CharacterObjectBindingDto, RoleVoiceDto } from '../../../shared/business'
import {
  ActionGroup, Avatar, Badge, Button, DetailList, DetailRow, Dialog, EmptyState, ErrorState, Heading, Inline,
  LayoutSlot, ListBox, ListBoxItem, Loading, Page, PageContent, PageToolbar, SearchInput, Stack, Strong, Surface,
  SurfaceHeader, Text, useToast, VisualRegion, WindowTitleBar
} from '../../components/ui'
import { bridge } from '../../shared/bridge'
import { deleteCharacter, loadCharacters, setCurrentCharacter } from './character-api'

export function CharacterPage(): React.JSX.Element {
  const toast = useToast()
  const [items, setItems] = useState<CharacterDto[] | null>(null)
  const [current, setCurrent] = useState('')
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({})
  const [roleVoices, setRoleVoices] = useState<RoleVoiceDto[]>([])
  const [currentObjectKey, setCurrentObjectKey] = useState('')
  const [boundRoleId, setBoundRoleId] = useState('')

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    if (items === null || keyword === '') return items ?? []
    return items.filter((item) => [item.name, item.roleId, item.voiceName, item.preferredVoiceId]
      .some((value) => value.toLocaleLowerCase().includes(keyword)))
  }, [items, query])
  const selectedItem = items?.find((item) => item.roleId === selected) ?? null

  async function load(): Promise<void> {
    try {
      const data = await loadCharacters()
      setItems(data.items)
      setCurrent(data.currentRoleId)
      setSelected((value) => data.items.some((item) => item.roleId === value)
        ? value
        : data.items.find((item) => item.roleId === data.currentRoleId)?.roleId ?? data.items[0]?.roleId ?? '')
      setError(null)
      const presentation = await bridge.pet.presentation.get()
      const snapshot = presentation.success ? presentation.payload : null
      const objectKey = snapshot?.currentObjectKey ?? ''
      setCurrentObjectKey(objectKey)
      if (objectKey === '') setBoundRoleId('')
      else {
        const binding = await bridge.core.invoke({ type: 'character.binding.get', payload: { targetKey: objectKey } })
        setBoundRoleId(binding.success && binding.payload !== null ? (binding.payload as CharacterObjectBindingDto).roleId : '')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (items === null) return
    void Promise.all(items.filter((item) => item.avatarPath !== '').map(async (item) => {
      const response = await bridge.media.registerLocalFile(item.avatarPath)
      return [item.roleId, response.success ? response.payload?.url ?? '' : ''] as const
    })).then((entries) => setAvatarUrls(Object.fromEntries(entries)))
  }, [items])
  useEffect(() => {
    if (selected === '') { setRoleVoices([]); return }
    setRoleVoices([])
    void bridge.core.invoke({ type: 'character.voices', payload: { roleId: selected } }).then((response) => {
      if (!response.success || !Array.isArray(response.payload)) throw new Error(response.error?.message ?? '角色语音列表读取失败。')
      setRoleVoices(response.payload as RoleVoiceDto[])
    }).catch((reason: unknown) => toast.show(reason instanceof Error ? reason.message : String(reason), 'error'))
  }, [selected, toast])
  useEffect(() => {
    const reload = (): void => { void load() }
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [])

  async function choose(): Promise<void> {
    if (selectedItem === null || selectedItem.roleId === current) return
    try {
      setBusy(true)
      await setCurrentCharacter(selectedItem.roleId)
      setCurrent(selectedItem.roleId)
      toast.show(`已切换语音角色：${selectedItem.name}`, 'success')
    } catch (reason) {
      toast.show(reason instanceof Error ? reason.message : String(reason), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function removeSelected(): Promise<void> {
    if (selectedItem === null) return
    try {
      setBusy(true)
      await deleteCharacter(selectedItem.roleId)
      setDeleteConfirm(false)
      await load()
      toast.show(`已删除语音角色：${selectedItem.name}`, 'success')
    } catch (reason) {
      toast.show(reason instanceof Error ? reason.message : String(reason), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function bindSelected(): Promise<void> {
    if (selectedItem === null) return
    if (currentObjectKey === '') { toast.show('当前没有可绑定的对象。', 'error'); return }
    setBusy(true)
    const response = await bridge.core.invoke({ type: 'character.binding.set', payload: { targetKey: currentObjectKey, roleId: selectedItem.roleId } })
    setBusy(false)
    if (!response.success) { toast.show(response.error?.message ?? '角色绑定失败。', 'error'); return }
    setBoundRoleId(selectedItem.roleId)
    toast.show(`已绑定语音角色：${selectedItem.name}`, 'success')
  }

  async function unbindCurrent(): Promise<void> {
    if (currentObjectKey === '') { toast.show('当前没有可绑定的对象。', 'error'); return }
    setBusy(true)
    const response = await bridge.core.invoke({ type: 'character.binding.clear', payload: { targetKey: currentObjectKey } })
    setBusy(false)
    if (!response.success) { toast.show(response.error?.message ?? '角色解绑失败。', 'error'); return }
    setBoundRoleId('')
    toast.show('已解除当前对象的语音角色绑定。', 'success')
  }

  async function openCurrentCard(): Promise<void> {
    if (selectedItem === null) return
    localStorage.setItem('aimaid.template-card-role', JSON.stringify(selectedItem))
    const response = await bridge.window.open('template-card')
    if (!response.success) toast.show(response.error?.message ?? '角色卡窗口打开失败。', 'error')
  }

  async function openEditor(item: CharacterDto | null): Promise<void> {
    if (item === null) localStorage.removeItem('aimaid.character-editor-role')
    else localStorage.setItem('aimaid.character-editor-role', JSON.stringify(item))
    const response = await bridge.window.open('character-editor')
    if (!response.success) toast.show(response.error?.message ?? '角色编辑窗口打开失败。', 'error')
  }

  if (items === null && error === null) return <Page><PageContent><Loading label="正在加载语音角色…" /></PageContent></Page>
  if (items === null) return <ErrorState title="语音角色加载失败" message={error ?? ''} onRetry={() => void load()} />

  const currentName = items.find((item) => item.roleId === current)?.name ?? '未选择'
  return <Page>
    <WindowTitleBar title="语音角色管理" />
    <PageContent scroll={false}>
      <LayoutSlot variant="character-page-layout">
      <PageToolbar
        lead={<Inline><Text tone="secondary">当前角色</Text><Strong>{currentName}</Strong></Inline>}
        actions={<>
        <SearchInput aria-label="搜索角色" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Button variant="primary" onClick={() => void openEditor(null)}>新增</Button>
        </>}
      />
      <LayoutSlot variant="character-workspace">
        <Surface variant="character-navigation">
          <SurfaceHeader title="角色列表" meta={`${filtered.length}/${items.length}`} />
          {filtered.length === 0 ? <EmptyState title={items.length === 0 ? '还没有角色' : '没有匹配的角色'} /> : <ListBox label="角色列表">{filtered.map((item) => <ListBoxItem
            key={item.roleId}
            selected={item.roleId === selected}
            leading={<Avatar source={avatarUrls[item.roleId] ?? ''} fallback={item.name || item.roleId} />}
            title={item.name || item.roleId}
            description={item.preferredVoiceId || item.voiceName || item.roleId}
            badge={item.roleId === current ? <Badge tone="accent">当前</Badge> : item.roleId === boundRoleId ? <Badge>已绑定</Badge> : undefined}
            onSelect={() => setSelected(item.roleId)}
          />)}</ListBox>}
        </Surface>
        <Surface variant="character-detail">
          {selectedItem === null ? <EmptyState title="请选择角色" /> : <>
          <LayoutSlot as="header" variant="character-summary">
            <VisualRegion ratio="square"><Avatar source={avatarUrls[selectedItem.roleId] ?? ''} fallback={selectedItem.name || '—'} size="preview" /></VisualRegion>
            <Stack gap="xs"><Heading>{selectedItem.name || selectedItem.roleId}</Heading><Text tone="muted">角色 ID：{selectedItem.roleId}</Text><Inline><Badge tone={selectedItem.roleId === current ? 'accent' : 'neutral'}>{selectedItem.roleId === current ? '当前角色' : '可切换'}</Badge><Badge>{selectedItem.roleId === boundRoleId ? '已绑定当前对象' : '未绑定当前对象'}</Badge></Inline></Stack>
            <ActionGroup><Button variant="primary" loading={busy} disabled={selectedItem.roleId === current || !selectedItem.isEnabled} onClick={() => void choose()}>设为当前</Button><Button onClick={() => void openEditor(selectedItem)}>编辑</Button><Button onClick={() => void openCurrentCard()}>角色卡</Button></ActionGroup>
          </LayoutSlot>
          <Stack>
            <LayoutSlot variant="character-detail-sections">
            <DetailList title="角色资料">
              <DetailRow label="角色名称" value={selectedItem?.name || '-'} />
              <DetailRow label="头像文件" value={fileName(selectedItem?.avatarPath) || '未配置'} wrap />
              <DetailRow label="启用状态" value={selectedItem.isEnabled ? '已启用' : '已停用'} />
            </DetailList>
            <DetailList title="音色">
              <DetailRow label="默认音色" value={selectedItem.preferredVoiceId || selectedItem.voiceName || '-'} />
              <DetailRow label="可用音色" value={`${roleVoices.length} 个`} />
            </DetailList>
            <DetailList title="角色卡状态">
              <DetailRow label="原角色卡" value={selectedItem.sourceCardJson ? '已配置' : '未配置'} />
              <DetailRow label="当前角色卡" value={formatTemplateStatus(selectedItem)} />
              <DetailRow label="生成时间" value={formatDate(selectedItem?.templateCardGeneratedAt)} />
            </DetailList>
            </LayoutSlot>
            <Surface variant="character-binding"><SurfaceHeader title="当前对象绑定" meta={selectedItem.roleId === boundRoleId ? '已绑定' : '未绑定'} /><Text as="p" tone="secondary" wrap>{currentObjectKey === '' ? '当前没有可绑定对象。' : `当前对象：${fileName(currentObjectKey)}`}</Text><ActionGroup><Button disabled={currentObjectKey === '' || selectedItem.roleId === boundRoleId || busy} onClick={() => void bindSelected()}>绑定此角色</Button><Button disabled={currentObjectKey === '' || boundRoleId === '' || busy} onClick={() => void unbindCurrent()}>解绑</Button></ActionGroup></Surface>
            <LayoutSlot as="section" variant="character-danger"><Stack gap="sm"><Strong>危险操作</Strong><Text tone="secondary">删除会同时清除该角色的音色、角色卡和绑定。</Text><Button variant="danger" onClick={() => setDeleteConfirm(true)}>删除角色</Button></Stack></LayoutSlot>
          </Stack>
          </>}
        </Surface>
      </LayoutSlot>
      </LayoutSlot>
    </PageContent>
    <Dialog open={deleteConfirm} title="删除语音角色" onClose={() => setDeleteConfirm(false)} footer={<><Button disabled={busy} onClick={() => setDeleteConfirm(false)}>取消</Button><Button variant="danger" loading={busy} onClick={() => void removeSelected()}>删除</Button></>}><Text as="p" wrap>删除角色“{selectedItem?.name ?? ''}”？关联音色、角色卡和绑定也会被清除。</Text></Dialog>
  </Page>
}

function formatTemplateStatus(item: CharacterDto | null): string {
  if (item === null) return '-'
  if (['ready', 'completed'].includes(item.templateCardGenerationStatus.toLowerCase()) && item.templateCardJson !== '') return '已生成'
  if (item.templateCardGenerationStatus.toLowerCase() === 'generating') return '生成中'
  if (item.templateCardGenerationStatus.toLowerCase() === 'failed') return '生成失败'
  return '尚未生成'
}

function fileName(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value.split(/[\\/]/u).filter(Boolean).at(-1) ?? ''
}

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '尚未生成'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '尚未生成' : date.toLocaleString('zh-CN')
}
