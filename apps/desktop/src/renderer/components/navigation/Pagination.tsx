import { IconButton } from '../base/IconButton'
import { Select } from '../forms/Select'
export interface PaginationProps { page: number; pageSize: number; total: number; onPageChange: (page: number) => void; onPageSizeChange?: (pageSize: number) => void; pageSizeOptions?: readonly number[]; loading?: boolean }
export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, pageSizeOptions = [10, 20, 50], loading = false }: PaginationProps): React.JSX.Element {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <nav className="ui-pagination" aria-label="分页">
    <span>共 {total} 项</span>
    {onPageSizeChange !== undefined ? <Select aria-label="每页数量" value={String(pageSize)} options={pageSizeOptions.map((value) => ({ value: String(value), label: `${value} / 页` }))} onChange={(event) => onPageSizeChange(Number(event.target.value))}/> : null}
    <IconButton label="上一页" size="sm" disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)}>‹</IconButton>
    <span>{page} / {pages}</span>
    <IconButton label="下一页" size="sm" disabled={loading || page >= pages} onClick={() => onPageChange(page + 1)}>›</IconButton>
  </nav>
}
