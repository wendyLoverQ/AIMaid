import { Container, FormLabel, InlineText, Paragraph, ProductList, ProductPage, ProductPanel, ProductSidebar, ProductStatusBar, ProductWorkspace, Strong } from "../../components/ui";
import { useEffect, useState } from 'react';
import type { ChatCommandLauncherDto } from '../../../shared/business';
import { Button } from '../../components/ui';
import { Pressable } from '../../components/ui';
import { Input } from '../../components/ui';
import { Switch } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { Dialog } from '../../components/ui';
import { bridge } from '../../shared/bridge';
export function ScriptsPage(): React.JSX.Element {
    const [items, setItems] = useState<ChatCommandLauncherDto[]>([]);
    const [launcherId, setLauncherId] = useState('');
    const [command, setCommand] = useState('');
    const [name, setName] = useState('');
    const [exePath, setExePath] = useState('');
    const [argumentsValue, setArgumentsValue] = useState('');
    const [workingDirectory, setWorkingDirectory] = useState('');
    const [enabled, setEnabled] = useState(true);
    const [status, setStatus] = useState('');
    const [warning, setWarning] = useState('');
    const commandIsValid = command.trim().startsWith('-') && command.trim().length >= 2 && command.trim().length <= 32 && !/\s/u.test(command.trim());
    const canSave = commandIsValid && name.trim() !== '' && exePath.trim() !== '';
    useEffect(() => { void reload(); }, []);
    const reload = async (preferredId?: string): Promise<void> => {
        const response = await bridge.core.invoke({ type: 'script.list', payload: {} });
        if (!response.success || !Array.isArray(response.payload)) {
            setWarning(response.error?.message ?? '快捷脚本读取失败。');
            return;
        }
        const values = response.payload as ChatCommandLauncherDto[];
        setItems(values);
        const selected = values.find((item) => item.launcherId === preferredId) ?? values[0];
        if (selected !== undefined)
            selectItem(selected);
        else
            newItem();
    };
    const selectItem = (item: ChatCommandLauncherDto): void => {
        setLauncherId(item.launcherId);
        setCommand(item.commandText);
        setName(item.displayName);
        setExePath(item.exePath);
        setArgumentsValue(item.arguments);
        setWorkingDirectory(item.workingDirectory);
        setEnabled(item.enabled);
        setStatus(`最后修改：${new Date(item.updatedAt).toLocaleString('zh-CN')}`);
    };
    const newItem = (): void => {
        setLauncherId('');
        setCommand('');
        setName('');
        setExePath('');
        setArgumentsValue('');
        setWorkingDirectory('');
        setEnabled(true);
        setStatus('');
    };
    const chooseExecutable = async (): Promise<void> => {
        const response = await bridge.dialog.openFile([
            { name: '程序或脚本', extensions: ['exe', 'bat', 'cmd', 'ps1', 'vbs', 'js'] },
            { name: '所有文件', extensions: ['*'] }
        ]);
        if (!response.success) {
            setWarning(response.error?.message ?? '程序选择失败。');
            return;
        }
        const path = readPaths(response.payload)[0];
        if (path !== undefined)
            setExePath(path);
    };
    const chooseWorkingDirectory = async (): Promise<void> => {
        const response = await bridge.dialog.openDirectory();
        if (!response.success) {
            setWarning(response.error?.message ?? '工作目录选择失败。');
            return;
        }
        const path = response.payload?.filePaths[0];
        if (path !== undefined)
            setWorkingDirectory(path);
    };
    const save = async (): Promise<void> => {
        const trimmed = command.trim();
        if (!trimmed.startsWith('-') || trimmed.length < 2 || trimmed.length > 32 || /\s/u.test(trimmed)) {
            setWarning('聊天指令必须以“-”开头、不含空格，且不超过 32 个字符。');
            return;
        }
        if (name.trim() === '' || exePath.trim() === '') {
            setWarning('显示名称和程序或脚本路径不能为空。');
            return;
        }
        const response = await bridge.core.invoke({ type: 'script.save', payload: { launcher: {
                    launcherId, commandText: trimmed, displayName: name.trim(), exePath: exePath.trim(), arguments: argumentsValue,
                    workingDirectory: workingDirectory.trim(), enabled, updatedAt: new Date().toISOString()
                } } });
        if (!response.success || !isLauncher(response.payload)) {
            setWarning(response.error?.message ?? '保存失败。');
            return;
        }
        await reload(response.payload.launcherId);
        setStatus('已保存，聊天框可立即使用。');
    };
    const run = async (): Promise<void> => {
        if (launcherId === '') {
            setStatus('请先保存，再运行测试。');
            return;
        }
        const response = await bridge.core.invoke({ type: 'script.run', payload: { launcherId } });
        setStatus(response.success && typeof response.payload === 'string' ? response.payload : response.error?.message ?? '启动失败。');
    };
    return <ProductPage>
    <WindowTitleBar title="快捷脚本"/>
    <ProductWorkspace layout="sidebar">
      <ProductSidebar title="快捷指令" description={`${items.length} 条可用指令`} actions={<Button size="sm" variant="primary" onClick={newItem}>新增</Button>}>
        {items.length === 0 ? <Container>暂无快捷指令</Container> : <ProductList>{items.map((item) => <Pressable selected={item.launcherId === launcherId} key={item.launcherId} onClick={() => selectItem(item)}><Strong>{item.displayName}</Strong><InlineText>{item.commandText}</InlineText></Pressable>)}</ProductList>}
      </ProductSidebar>
      <ProductPanel title={launcherId === '' ? '新建快捷指令' : name || command} actions={<><Button disabled={launcherId === ''} onClick={() => void run()}>运行测试</Button><Button variant="primary" disabled={!canSave} onClick={() => void save()}>保存</Button></>} footer={status !== '' ? <ProductStatusBar>{status}</ProductStatusBar> : undefined} scroll emphasis>
        <FormField label="聊天指令"><Input aria-label="聊天指令" value={command} onChange={(event) => setCommand(event.target.value)}/></FormField>
        <FormField label="显示名称"><Input aria-label="显示名称" value={name} onChange={(event) => setName(event.target.value)}/></FormField>
        <PathField label="程序或脚本路径" value={exePath} setValue={setExePath} browse={() => void chooseExecutable()}/>
        <FormField label="启动参数"><Input aria-label="启动参数" value={argumentsValue} onChange={(event) => setArgumentsValue(event.target.value)}/></FormField>
        <PathField label="工作目录" value={workingDirectory} setValue={setWorkingDirectory} browse={() => void chooseWorkingDirectory()}/>
        <Switch label="启用此快捷指令" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/>
      </ProductPanel>
    </ProductWorkspace>
    <Dialog open={warning !== ''} title="快捷脚本" onClose={() => setWarning('')} footer={<Button variant="primary" onClick={() => setWarning('')}>确定</Button>}><Paragraph>{warning}</Paragraph></Dialog>
  </ProductPage>;
}
function FormField({ label, children }: {
    label: string;
    children: React.ReactNode;
}): React.JSX.Element { return <FormLabel><InlineText>{label}</InlineText>{children}</FormLabel>; }
function PathField({ label, value, setValue, browse }: {
    label: string;
    value: string;
    setValue: (value: string) => void;
    browse: () => void;
}): React.JSX.Element {
    return <FormField label={label}><Container><Input aria-label={label} value={value} onChange={(event) => setValue(event.target.value)}/><Button onClick={browse}>浏览</Button></Container></FormField>;
}
function readPaths(value: unknown): string[] { return typeof value === 'object' && value !== null && 'filePaths' in value && Array.isArray(value.filePaths) ? value.filePaths.filter((item): item is string => typeof item === 'string') : []; }
function isLauncher(value: unknown): value is ChatCommandLauncherDto { return typeof value === 'object' && value !== null && 'launcherId' in value && typeof value.launcherId === 'string'; }
