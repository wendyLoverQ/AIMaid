export interface TreeNode { id: string; label: string; children?: readonly TreeNode[]; disabled?: boolean }
export interface TreeProps { label: string; nodes: readonly TreeNode[]; selectedId?: string; onSelect: (id: string) => void }
export function Tree({ label, nodes, selectedId, onSelect }: TreeProps): React.JSX.Element { return <div className="ui-tree" role="tree" aria-label={label}>{render(nodes, 1, selectedId, onSelect)}</div> }
function render(nodes: readonly TreeNode[], level: number, selectedId: string | undefined, onSelect: (id: string) => void): React.JSX.Element[] { return nodes.map((node) => <div key={node.id} role="treeitem" aria-level={level} aria-selected={node.id === selectedId} aria-disabled={node.disabled}>
  <button type="button" disabled={node.disabled} onClick={() => onSelect(node.id)}><span aria-hidden="true">{node.children === undefined ? '·' : '⌄'}</span>{node.label}</button>{node.children !== undefined ? <div role="group">{render(node.children, level + 1, selectedId, onSelect)}</div> : null}
</div>) }
