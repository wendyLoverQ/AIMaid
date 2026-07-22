import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotebookNoteDto } from '../../../shared/business'
import { Button, ConfirmDialog, EmptyState, Inline, Input, LayoutSlot, ListBox, ListBoxItem, Page, PageContent, RichTextEditor, SearchBox, Stack, Surface, SurfaceHeader, Text, WindowTitleBar, useToast } from '../../components/ui'
import type { RichTextEditorHandle } from '../../components/ui'
import { bridge } from '../../shared/bridge'

export function NotebookPage(): React.JSX.Element {
  const toast = useToast(); const editor = useRef<RichTextEditorHandle>(null)
  const [notes, setNotes] = useState<NotebookNoteDto[]>([]); const [selectedId, setSelectedId] = useState<string>(); const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<NotebookNoteDto>(); const [dirty, setDirty] = useState(false); const [deleting, setDeleting] = useState(false)
  const draftRef = useRef<NotebookNoteDto | undefined>(undefined); const dirtyRef = useRef(false); const revisionRef = useRef(0); const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const load = useCallback(async (preferredId?: string): Promise<void> => {
    const response = await bridge.core.invoke({ type: 'notebook.list', payload: {} })
    if (!response.success) throw new Error(response.error?.message ?? '笔记读取失败。')
    const items = Array.isArray(response.payload) ? response.payload as NotebookNoteDto[] : []
    setNotes(items); const id = preferredId ?? items[0]?.noteId; const next = items.find((item) => item.noteId === id); setSelectedId(id); setDraft(next); draftRef.current = next; setDirty(false); dirtyRef.current = false
  }, [])
  useEffect(() => { void load().catch((reason: unknown) => toast.show(String(reason), 'error')) }, [])
  const persist = useCallback(async (note: NotebookNoteDto, revision: number): Promise<NotebookNoteDto> => {
    const next = { ...note, updatedAt: new Date().toISOString() }
    const operation = saveQueue.current.then(async () => {
      const response = await bridge.core.invoke({ type: 'notebook.save', payload: { note: next } })
      if (!response.success) throw new Error(response.error?.message ?? '笔记保存失败。')
      setNotes((current) => [...current.filter((item) => item.noteId !== next.noteId), next])
      if (draftRef.current?.noteId === next.noteId && revisionRef.current === revision) {
        draftRef.current = next; setDraft(next); dirtyRef.current = false; setDirty(false)
      }
    })
    saveQueue.current = operation.catch(() => undefined)
    await operation
    return next
  }, [])
  const flushDraft = useCallback(async (): Promise<void> => {
    while (draftRef.current !== undefined && dirtyRef.current) await persist(draftRef.current, revisionRef.current)
    await saveQueue.current
  }, [persist])
  useEffect(() => { if (!dirty || draft === undefined) return; const timer = window.setTimeout(() => void flushDraft().catch((reason: unknown) => toast.show(String(reason), 'error')), 600); return () => window.clearTimeout(timer) }, [dirty, draft, flushDraft, toast])
  const create = async (): Promise<void> => {
    await flushDraft()
    const previousNoteId = draftRef.current?.noteId
    const now = new Date().toISOString(); const note: NotebookNoteDto = { noteId: String(Date.now()), title: '', contentMarkdown: '<p><br></p>', contentPlainText: '', attachmentIds: [], isPinned: false, isDeleted: false, createdAt: now, updatedAt: now }
    revisionRef.current += 1; const saved = await persist(note, revisionRef.current)
    if (draftRef.current?.noteId === previousNoteId && dirtyRef.current) await flushDraft()
    setSelectedId(saved.noteId); setDraft(saved); draftRef.current = saved; setDirty(false); dirtyRef.current = false; editor.current?.focus()
  }
  const choose = async (note: NotebookNoteDto): Promise<void> => { await flushDraft(); setSelectedId(note.noteId); setDraft(note); draftRef.current = note; setDirty(false); dirtyRef.current = false }
  const patchDraft = (patch: Partial<NotebookNoteDto>): void => { const current = draftRef.current; if (current === undefined) return; const next = { ...current, ...patch }; revisionRef.current += 1; draftRef.current = next; setDraft(next); dirtyRef.current = true; setDirty(true) }
  const importImages = async (files: readonly File[]): Promise<void> => {
    for (const file of files) {
      const dataUrl = await readDataUrl(file); const response = await bridge.notebook.importData(file.name, dataUrl)
      const imported = response.payload
      if (!response.success || imported === undefined || imported === null) { toast.show(response.error?.message ?? '图片导入失败。', 'error'); continue }
      editor.current?.insertHtml(`<img src="${escapeAttribute(imported.url)}" data-path="${escapeAttribute(imported.path)}" alt="${escapeAttribute(file.name)}">`)
      patchDraft({ attachmentIds: [...(draft?.attachmentIds ?? []), imported.path] })
    }
  }
  const chooseImages = async (): Promise<void> => {
    const response = await bridge.dialog.openFile([{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }])
    const paths = response.success ? readFilePaths(response.payload) : []
    for (const path of paths) {
      const imported = await bridge.notebook.importFile(path)
      if (!imported.success || imported.payload === null) { toast.show(imported.error?.message ?? '图片导入失败。', 'error'); continue }
      editor.current?.insertHtml(`<img src="${escapeAttribute(imported.payload.url)}" data-path="${escapeAttribute(imported.payload.path)}" alt="${escapeAttribute(imported.payload.name)}">`)
      patchDraft({ attachmentIds: [...(draft?.attachmentIds ?? []), imported.payload.path] })
    }
  }
  const attachmentAction = async (action: 'copy' | 'openLocation' | 'saveAs', path: string): Promise<void> => {
    const response = await bridge.notebook.imageAction(action, path)
    if (!response.success) toast.show(response.error?.message ?? '图片操作失败。', 'error')
  }
  const removeAttachment = (path: string): void => {
    if (draft === undefined) return
    const document = new DOMParser().parseFromString(draft.contentMarkdown, 'text/html')
    document.querySelectorAll('img').forEach((image) => { if (image.getAttribute('data-path') === path) image.remove() })
    patchDraft({ contentMarkdown: document.body.innerHTML, contentPlainText: document.body.innerText, attachmentIds: draft.attachmentIds.filter((item) => item !== path) })
  }
  const deleteCurrent = async (): Promise<void> => {
    if (draft === undefined) return
    const response = await bridge.core.invoke({ type: 'notebook.delete', payload: { noteId: draft.noteId } })
    if (!response.success) { toast.show(response.error?.message ?? '笔记删除失败。', 'error'); return }
    setDeleting(false); setSelectedId(undefined); setDraft(undefined); draftRef.current = undefined; dirtyRef.current = false; setDirty(false); await load()
  }
  const filtered = notes.filter((note) => `${note.title} ${note.contentPlainText}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt))
  return <Page><WindowTitleBar title="记事本" onClose={async () => { try { await flushDraft(); await bridge.window.close() } catch (reason) { toast.show(`关闭前保存失败：${String(reason)}`, 'error') } }}/><PageContent scroll={false}>
    <LayoutSlot variant="notebook-workspace">
      <Surface variant="notebook-navigation"><Stack gap="sm"><SurfaceHeader title="笔记" meta={<Text size="xs" tone="muted">{filtered.length}/{notes.length}</Text>}/><SearchBox aria-label="搜索笔记" value={query} onChange={setQuery}/><Button variant="primary" onClick={() => void create()}>新建笔记</Button></Stack>
        <LayoutSlot variant="notebook-list">{filtered.length === 0 ? <EmptyState title={notes.length === 0 ? '暂无笔记' : '没有匹配的笔记'} /> : <ListBox label="笔记列表">{filtered.map((note) => <ListBoxItem key={note.noteId} selected={note.noteId === selectedId} title={note.title || '无标题'} description={`${note.contentPlainText || '暂无内容'} · ${new Date(note.updatedAt).toLocaleString('zh-CN')}`} badge={note.isPinned ? <Text size="xs">已置顶</Text> : undefined} onSelect={() => void choose(note).catch((reason: unknown) => toast.show(String(reason), 'error'))}/>)}</ListBox>}</LayoutSlot>
      </Surface>
      <Surface variant="notebook-editor">{draft === undefined ? <EmptyState title="选择或新建笔记"/> : <Stack gap="none">
        <LayoutSlot as="header" variant="notebook-editor__header"><Input aria-label="笔记标题" value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })}/><Text size="xs" tone={dirty ? 'secondary' : 'muted'}>{dirty ? '保存中…' : '已保存'}</Text></LayoutSlot>
        <LayoutSlot variant="notebook-toolbar"><Inline><Button size="sm" onClick={() => void chooseImages()}>插入图片</Button><Button size="sm" onClick={() => patchDraft({ isPinned: !draft.isPinned })}>{draft.isPinned ? '取消置顶' : '置顶'}</Button><Button size="sm" onClick={() => void navigator.clipboard.writeText(draft.contentPlainText)}>复制正文</Button></Inline><Inline><Button size="sm" onClick={() => void flushDraft().catch((reason: unknown) => toast.show(String(reason), 'error'))}>立即保存</Button><Button size="sm" variant="danger" onClick={() => setDeleting(true)}>删除</Button></Inline></LayoutSlot>
        <LayoutSlot variant="notebook-editor__body"><RichTextEditor ref={editor} label="笔记正文" value={draft.contentMarkdown} onChange={(html, text) => patchDraft({ contentMarkdown: html, contentPlainText: text })} onPasteFiles={(files) => void importImages(files)}/>
          {draft.attachmentIds.length > 0 ? <LayoutSlot as="section" variant="notebook-attachments" aria-label="图片附件"><Text size="sm" tone="secondary">图片附件</Text>{draft.attachmentIds.map((path) => <LayoutSlot variant="notebook-attachment" key={path}><Text size="xs" tone="muted" wrap>{path}</Text><Inline><Button size="sm" onClick={() => void attachmentAction('copy', path)}>复制</Button><Button size="sm" onClick={() => void attachmentAction('openLocation', path)}>打开位置</Button><Button size="sm" onClick={() => void attachmentAction('saveAs', path)}>另存为</Button><Button size="sm" variant="danger" onClick={() => removeAttachment(path)}>移除</Button></Inline></LayoutSlot>)}</LayoutSlot> : null}
        </LayoutSlot>
      </Stack>}</Surface>
    </LayoutSlot>
    <ConfirmDialog open={deleting} title="删除笔记？" description="删除后无法恢复。" confirmText="删除" confirmVariant="danger" onCancel={() => setDeleting(false)} onConfirm={() => void deleteCurrent()}/>
  </PageContent></Page>
}

function readDataUrl(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') resolve(reader.result); else reject(new Error('图片读取结果不是 Data URL。')) }; reader.onerror = () => reject(reader.error ?? new Error('图片读取失败。')); reader.readAsDataURL(file) }) }
function escapeAttribute(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') }
function readFilePaths(value: unknown): string[] { return typeof value === 'object' && value !== null && 'filePaths' in value && Array.isArray(value.filePaths) ? value.filePaths.filter((item): item is string => typeof item === 'string') : [] }
