export function StatusPill({ status }: { status: string }): React.JSX.Element {
  return <span className={`status-pill status-${status}`}>{status}</span>
}
