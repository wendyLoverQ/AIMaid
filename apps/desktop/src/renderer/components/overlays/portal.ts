const PORTAL_ROOT_ID = 'aimaid-ui-portal-root'

export function getPortalRoot(): HTMLElement {
  const existing = document.getElementById(PORTAL_ROOT_ID)
  if (existing !== null) return existing
  const root = document.createElement('div')
  root.id = PORTAL_ROOT_ID
  root.dataset.uiPortal = 'true'
  document.body.append(root)
  return root
}
