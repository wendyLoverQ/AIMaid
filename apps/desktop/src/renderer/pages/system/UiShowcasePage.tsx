import { Accordion, Alert, AudioPlayer, Avatar, Badge, Card, CircularProgress, ColorPalette, Combobox, ConfirmDialog, Container, DataTable, DateInput, DateTimeInput, FilePicker, InlineText, ListBox, ListBoxItem, NumberInput, Pagination, Paragraph, Popover, ProductGrid, ProductHero, ProductMetric, ProductPanel, ProductStatusBar, ProductToolbar, Progress, RadioGroup, Range, SearchBox, SearchInput, SegmentedControl, ShowcaseContent, ShowcaseFormGrid, ShowcaseIcon, ShowcaseIconGrid, ShowcaseIntro, ShowcasePage, ShowcaseRow, ShowcaseSection, ShowcaseStateGrid, Skeleton, Spinner, Tag, Tree } from '../../components/ui';
import { useState } from 'react';
import { Button } from '../../components/ui';
import { IconButton } from '../../components/ui';
import { UiIcon } from '../../components/ui';
import type { UiIconName } from '../../components/ui';
import { EmptyState } from '../../components/ui';
import { ErrorState } from '../../components/ui';
import { Loading } from '../../components/ui';
import { OfflineState } from '../../components/ui';
import { UnauthorizedState } from '../../components/ui';
import { useToast } from '../../components/ui';
import { Checkbox } from '../../components/ui';
import { Input } from '../../components/ui';
import { Select } from '../../components/ui';
import { Switch } from '../../components/ui';
import { Textarea } from '../../components/ui';
import { ScrollArea } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { Tabs } from '../../components/ui';
import { ContextMenu } from '../../components/ui';
import { Dialog } from '../../components/ui';
import { Drawer } from '../../components/ui';
import { Menu } from '../../components/ui';
import { Tooltip } from '../../components/ui';
const ICONS = [
    'pause', 'layers', 'image', 'clock', 'folder', 'gauge', 'user', 'repeat',
    'sparkles', 'heart', 'trash', 'activity', 'grid', 'message', 'palette', 'settings'
] as const satisfies readonly UiIconName[];
export function UiShowcasePage(): React.JSX.Element {
    const toast = useToast();
    const [checked, setChecked] = useState(true);
    const [enabled, setEnabled] = useState(true);
    const [tab, setTab] = useState('normal');
    const [menuOpen, setMenuOpen] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [range, setRange] = useState(60);
    const [radio, setRadio] = useState('standard');
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [listItem, setListItem] = useState('one');
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [segment, setSegment] = useState<'list' | 'grid'>('list');
    const [page, setPage] = useState(1);
    const [combo, setCombo] = useState('role-a');
    const [tree, setTree] = useState('voice');
    return <ShowcasePage>
    <WindowTitleBar title="控件展示"/>
    <ShowcaseContent>
      <ShowcaseIntro title="基础控件" meta={<Badge tone="accent">GLOBAL UI</Badge>}/>
      <ShowcaseSection title="按钮 Button">
        <ShowcaseRow><Button variant="primary">主要按钮</Button><Button>次要按钮</Button><Button variant="ghost">幽灵按钮</Button><Button variant="danger">危险按钮</Button></ShowcaseRow>
        <ShowcaseRow><Button size="sm">小尺寸</Button><Button size="md">中尺寸</Button><Button size="lg">大尺寸</Button><Button disabled>禁用</Button><Button loading>加载中</Button></ShowcaseRow>
      </ShowcaseSection>

      <ShowcaseSection title="图标与图标按钮 IconButton">
        <ShowcaseIconGrid>{ICONS.map((name) => <ShowcaseIcon key={name} icon={<UiIcon name={name}/>} label={name}/>)}</ShowcaseIconGrid>
        <ShowcaseRow><IconButton label="小图标按钮" size="sm"><UiIcon name="settings"/></IconButton><IconButton label="中图标按钮"><UiIcon name="heart"/></IconButton><IconButton label="大图标按钮" size="lg"><UiIcon name="sparkles"/></IconButton><IconButton label="禁用图标按钮" disabled><UiIcon name="trash"/></IconButton><IconButton label="加载图标按钮" loading/></ShowcaseRow>
      </ShowcaseSection>

      <ShowcaseSection title="表单控件 Form Controls">
        <ShowcaseFormGrid>
          <Input label="普通输入框"/>
          <Input label="错误输入框" defaultValue="错误内容" error="这里显示校验错误"/>
          <Input label="禁用输入框" value="不可编辑" disabled readOnly/>
          <Select label="下拉选择" defaultValue="normal" options={[{ value: 'normal', label: '普通选项' }, { value: 'selected', label: '另一个选项' }, { value: 'disabled', label: '禁用选项', disabled: true }]}/>
          <Select label="错误选择" error="请选择有效项目" defaultValue="" options={[{ value: '', label: '请选择' }, { value: 'valid', label: '有效项目' }]}/>
          <Select label="禁用选择" disabled defaultValue="normal" options={[{ value: 'normal', label: '不可操作' }]}/>
          <Textarea label="多行文本" defaultValue="这里展示多行文本输入框。"/>
          <Textarea label="错误文本" defaultValue="需要修改的内容" error="内容格式不正确"/>
          <SearchInput label="搜索输入" value="" onChange={() => undefined}/>
          <NumberInput label="数字输入" value={12} onChange={() => undefined}/>
          <DateInput label="日期输入" value="2026-07-22" onChange={() => undefined}/>
          <DateTimeInput label="日期时间" value="2026-07-22T12:00" onChange={() => undefined}/>
          <Range label="滑动条" value={range} valueLabel={`${range}%`} min={0} max={100} onChange={(event) => setRange(Number(event.target.value))}/>
          <RadioGroup label="单选组" value={radio} onChange={setRadio} options={[{ value: 'soft', label: '柔和', description: '较低对比度' }, { value: 'standard', label: '标准' }, { value: 'clear', label: '清晰', disabled: true }]}/>
        </ShowcaseFormGrid>
        <ShowcaseRow>
          <Checkbox label="复选框" checked={checked} onChange={(event) => setChecked(event.target.checked)}/>
          <Checkbox label="未选中"/>
          <Checkbox label="禁用复选框" checked disabled readOnly/>
          <Switch label="开关已开启" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/>
          <Switch label="开关已关闭"/>
          <Switch label="禁用开关" checked disabled readOnly/>
        </ShowcaseRow>
      </ShowcaseSection>

      <ShowcaseSection title="数据展示 Data Display">
        <ShowcaseRow><Badge>默认</Badge><Badge tone="accent">强调</Badge><Badge tone="success">成功</Badge><Badge tone="warning">警告</Badge><Badge tone="danger">危险</Badge></ShowcaseRow>
        <ShowcaseRow><Tag>普通标签</Tag><Tag selected>已选标签</Tag><Tag onRemove={() => undefined}>可移除标签</Tag></ShowcaseRow>
        <Alert title="信息提示">页面内持续展示的重要信息。</Alert>
        <Alert tone="warning" title="需要注意">此状态不会像 Toast 一样自动消失。</Alert>
        <Progress label="任务进度" value={68}/>
        <Skeleton lines={3}/>
        <ShowcaseRow><Avatar fallback="女" size="sm"/><Avatar fallback="仆"/><Avatar fallback="长" size="lg"/><ColorPalette colors={['var(--color-bg-canvas)', 'var(--color-bg-elevated)', 'var(--color-accent)', 'var(--color-text-primary)']}/></ShowcaseRow>
        <ListBox label="列表示例">
          <ListBoxItem selected={listItem === 'one'} leading={<Avatar fallback="A"/>} title="已选项目" badge={<Badge tone="accent">当前</Badge>} onSelect={() => setListItem('one')}/>
          <ListBoxItem selected={listItem === 'two'} title="普通项目" onSelect={() => setListItem('two')}/>
          <ListBoxItem disabled title="禁用项目" onSelect={() => undefined}/>
        </ListBox>
        <Card header="卡片标题" footer={<Button size="sm">卡片操作</Button>}>卡片正文使用统一边框、圆角和间距。</Card>
        <Accordion title="可折叠区域" defaultOpen><Paragraph>折叠内容遵循统一键盘与高度规则。</Paragraph></Accordion>
        <DataTable label="示例数据表" rows={[{ id: '1', name: '角色资料', status: '正常' }, { id: '2', name: '语音记录', status: '处理中' }]} rowKey={(row) => row.id} columns={[{ key: 'name', header: '名称', render: (row) => row.name }, { key: 'status', header: '状态', render: (row) => <Badge>{row.status}</Badge> }]}/>
        <Pagination page={page} pageSize={10} total={42} onPageChange={setPage}/>
      </ShowcaseSection>

      <ShowcaseSection title="导航与反馈 Navigation / Feedback">
        <Tabs label="控件状态" value={tab} onChange={setTab} items={[{ id: 'normal', label: '普通' }, { id: 'active', label: '选中' }, { id: 'disabled', label: '禁用', disabled: true }]}/>
        <ShowcaseRow><Loading size="sm" label="小型加载"/><Loading label="中型加载"/><Loading size="lg" label="大型加载"/><Spinner size="xl" label="页面加载"/><CircularProgress value={72} label="圆形进度 72%"/></ShowcaseRow>
        <ShowcaseRow><InlineText>默认</InlineText><InlineText>正常</InlineText><InlineText>失败</InlineText></ShowcaseRow>
        <ShowcaseStateGrid>
          <EmptyState title="暂无内容" action={<Button size="sm">创建内容</Button>}/>
          <ErrorState message="操作未能完成，请检查后重试。" onRetry={() => toast.show('已触发重试示例。', 'info')}/>
          <OfflineState onRetry={() => toast.show('已触发重新连接示例。', 'info')}/>
          <UnauthorizedState onAuthorize={() => toast.show('已触发授权示例。', 'info')}/>
        </ShowcaseStateGrid>
      </ShowcaseSection>

      <ShowcaseSection title="滚动区域 ScrollArea">
        <ScrollArea maxHeight="sm">{Array.from({ length: 8 }, (_, index) => <Container key={index}>滚动内容第 {index + 1} 行</Container>)}</ScrollArea>
      </ShowcaseSection>

      <ShowcaseSection title="复合控件 Composites">
        <SearchBox aria-label="统一搜索框" value={query} onChange={setQuery} onSearch={(value) => toast.show(`搜索：${value}`)}/>
        <SegmentedControl label="布局方式" value={segment} onChange={setSegment} options={[{ value: 'list', label: '列表' }, { value: 'grid', label: '网格' }]}/>
        <Combobox label="角色搜索选择" value={combo} onChange={setCombo} options={[{ value: 'role-a', label: '女仆 A' }, { value: 'role-b', label: '女仆 B' }, { value: 'role-c', label: '不可用角色', disabled: true }]}/>
        <Tree label="模型目录" selectedId={tree} onSelect={setTree} nodes={[{ id: 'roles', label: '角色', children: [{ id: 'voice', label: '语音角色' }, { id: 'live2d', label: 'Live2D 模型' }] }, { id: 'media', label: '媒体库' }]}/>
        <FilePicker label="文件选择" onFiles={(files) => toast.show(`已选择 ${files.length} 个文件`, 'success')}/>
        <AudioPlayer source="" aria-label="音频播放器示例"/>
      </ShowcaseSection>

      <ShowcaseSection title="工作区布局 Workspace Patterns">
        <ProductToolbar lead={<SearchBox aria-label="工作区搜索" value="" onChange={() => undefined}/>} actions={<><Button>筛选</Button><Button variant="primary">新增</Button></>}/>
        <ProductHero eyebrow="正计时中" value="25:00" detail="主要数值保持唯一视觉焦点" actions={<><Button variant="primary">暂停</Button><Button>重置</Button></>}/>
        <ProductPanel title="数据概览" actions={<Button size="sm">刷新</Button>}>
          <ProductGrid density="metrics"><ProductMetric label="当前状态" value="正常"/><ProductMetric label="记录数量" value="128"/><ProductMetric label="最近更新" value="刚刚"/></ProductGrid>
        </ProductPanel>
        <ProductStatusBar actions={<Button size="sm">查看详情</Button>}>数据已同步</ProductStatusBar>
      </ShowcaseSection>

      <ShowcaseSection title="浮层与通知 Overlays">
        <ShowcaseRow>
          <Tooltip content="这是基础 Tooltip 样式"><Button>悬停提示</Button></Tooltip>
          <Menu open={menuOpen} label="示例菜单" onClose={() => setMenuOpen(false)} items={[
            { id: 'edit', label: '编辑', onSelect: () => toast.show('选择了编辑。') },
            { id: 'disabled', label: '禁用项目', disabled: true, onSelect: () => undefined },
            { id: 'delete', label: '删除', danger: true, onSelect: () => toast.show('选择了危险操作。', 'warning') }
        ]}><Button onClick={() => setMenuOpen((value) => !value)}>展开菜单</Button></Menu>
          <Button onClick={() => setDialogOpen(true)}>打开对话框</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>确认对话框</Button>
          <Button onClick={() => setDrawerOpen(true)}>打开抽屉</Button>
          <Popover open={popoverOpen} anchor={<Button onClick={() => setPopoverOpen((value) => !value)}>切换 Popover</Button>}><Paragraph>这是基础 Popover 内容。</Paragraph></Popover>
        </ShowcaseRow>
        <ContextMenu label="示例右键菜单" items={[
            { id: 'open', label: '打开', onSelect: () => toast.show('选择了打开。') },
            { id: 'disabled', label: '禁用项目', disabled: true, onSelect: () => undefined },
            { id: 'remove', label: '删除', danger: true, onSelect: () => toast.show('选择了删除。', 'warning') }
        ]}><Container>在这个区域点击右键，查看基础右键菜单</Container></ContextMenu>
        <ShowcaseRow>
          <Button onClick={() => toast.show('普通通知示例。')}>普通 Toast</Button>
          <Button onClick={() => toast.show('操作成功通知。', 'success')}>成功 Toast</Button>
          <Button onClick={() => toast.show('请注意当前状态。', 'warning')}>警告 Toast</Button>
          <Button onClick={() => toast.show('操作失败通知。', 'error')}>错误 Toast</Button>
        </ShowcaseRow>
      </ShowcaseSection>
    </ShowcaseContent>

    <Dialog open={dialogOpen} title="基础对话框" onClose={() => setDialogOpen(false)} footer={<><Button onClick={() => setDialogOpen(false)}>取消</Button><Button variant="primary" onClick={() => setDialogOpen(false)}>确定</Button></>}>
      <Input label="对话框内输入框"/>
    </Dialog>
    <Drawer open={drawerOpen} title="基础抽屉" onClose={() => setDrawerOpen(false)}>
      <Paragraph>这里展示抽屉的标题栏、内容区域和遮罩层。</Paragraph>
      <Input label="抽屉内输入框"/>
    </Drawer>
    <ConfirmDialog open={confirmOpen} title="删除记录？" description="删除后无法恢复。" confirmText="删除" confirmVariant="danger" onCancel={() => setConfirmOpen(false)} onConfirm={() => { setConfirmOpen(false); toast.show('已确认删除示例。', 'success') }}/>
  </ShowcasePage>;
}
