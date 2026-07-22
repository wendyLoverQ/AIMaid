export function Skeleton({ lines = 3 }: { lines?: number }): React.JSX.Element {
  return <div className="ui-skeleton" aria-hidden="true">{Array.from({ length: Math.max(1, lines) }, (_, index) => <span key={index} />)}</div>
}
