import type { ReactNode } from 'react'
import { EmptyState } from '../feedback/EmptyState'
import { Loading } from '../feedback/Loading'

export interface DataTableColumn<T> { key: string; header: string; width?: string; align?: 'left' | 'center' | 'right'; render: (row: T) => ReactNode }
export interface DataTableProps<T> { label: string; columns: readonly DataTableColumn<T>[]; rows: readonly T[]; rowKey: (row: T) => string; density?: 'compact' | 'default' | 'comfortable'; loading?: boolean; emptyTitle?: string }

export function DataTable<T>({ label, columns, rows, rowKey, density = 'default', loading = false, emptyTitle = '暂无数据' }: DataTableProps<T>): React.JSX.Element {
  if (loading) return <div className="ui-data-table__state"><Loading label="正在加载表格"/></div>
  if (rows.length === 0) return <EmptyState title={emptyTitle}/>
  return <div className="ui-data-table__scroll" tabIndex={0} role="region" aria-label={label}>
    <table className={`ui-data-table ui-data-table--${density}`}>
      <thead><tr>{columns.map((column) => <th key={column.key} scope="col" style={column.width !== undefined ? { width: column.width } : undefined} data-align={column.align}>{column.header}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={rowKey(row)}>{columns.map((column) => <td key={column.key} data-align={column.align}>{column.render(row)}</td>)}</tr>)}</tbody>
    </table>
  </div>
}
