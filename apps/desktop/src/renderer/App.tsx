import { lazy, Suspense } from 'react'
import { ChatPage } from './pages/chat/ChatPage'
import { MainPage } from './pages/main/MainPage'
import { SettingsPage } from './pages/settings/SettingsPage'

const PetPage = lazy(() => import('./pages/pet/PetPage'))

export function App(): React.JSX.Element {
  switch (window.aimaid.windowKind) {
    case 'main':
      return <MainPage />
    case 'pet':
      return (
        <Suspense fallback={<main className="shell compact">正在加载桌宠渲染入口…</main>}>
          <PetPage />
        </Suspense>
      )
    case 'chat':
      return <ChatPage />
    case 'settings':
      return <SettingsPage />
  }
}
