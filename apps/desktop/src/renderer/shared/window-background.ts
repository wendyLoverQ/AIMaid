export function syncWindowBackgroundColor(): void {
  const setBackgroundColor = window.aimaid.window.setBackgroundColor
  if (setBackgroundColor === undefined) return
  const color = getComputedStyle(document.documentElement).getPropertyValue('--color-bg-canvas').trim()
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color)) return
  void setBackgroundColor(color)
}
