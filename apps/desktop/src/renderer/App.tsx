import { lazy, Suspense } from 'react'
import { PromptPage } from './pages/chat/PromptPage'
import { VoiceInputPage } from './pages/chat/VoiceInputPage'
import { CharacterPage } from './features/characters/CharacterPage'
import { TemplateCardPage } from './features/characters/TemplateCardPage'
import { CharacterEditorPage } from './features/characters/CharacterEditorPage'
import { ReminderPage } from './features/reminders/ReminderPage'
import { AppearanceSettingsPage } from './pages/appearance/AppearanceSettingsPage'
import { BitcoinPage } from './pages/bitcoin/BitcoinPage'
import { CryptoChartPage, CryptoEventCenterPage, CryptoProviderSettingsPage } from './pages/bitcoin/CryptoSubwindowPages'
import { NotebookPage } from './pages/notebook/NotebookPage'
import { VoiceConversationPage } from './pages/voice-conversation/VoiceConversationPage'
import { VideoLibraryPage } from './pages/video/VideoLibraryPage'
import { VideoPlayerPage, VideoSubtitlesPage } from './pages/video/VideoSubwindows'
import { MainPage } from './pages/main/MainPage'
import { SettingsPage } from './pages/settings/SettingsPage'
import { RemoteVideoPage } from './pages/remote-video/RemoteVideoPage'
import { RemoteSiteConfigPage } from './pages/remote-video/RemoteSiteConfigPage'
import { ScriptsPage } from './pages/scripts/ScriptsPage'
import { StatusPage } from './pages/status/StatusPage'
import { TimerPage } from './pages/timer/TimerPage'
import { VaultPage } from './pages/vault/VaultPage'
import { bridge } from './shared/bridge'
import { AgentConfirmPage } from './pages/system/AgentConfirmPage'
import { TrayMenuPage } from './pages/system/TrayMenuPage'
import { DouyinLoginPage } from './pages/remote-video/DouyinLoginPage'
import { UiShowcasePage } from './pages/system/UiShowcasePage'

const PetPage = lazy(() => import('./pages/pet/PetPage'))

export function App(): React.JSX.Element {
  switch (bridge.window.kind) {
    case 'main':
      return <MainPage />
    case 'pet':
      return (
        <Suspense fallback={<main className="pet-shell">正在加载桌宠渲染入口…</main>}>
          <PetPage />
        </Suspense>
      )
    case 'chat':
      return <PromptPage />
    case 'voice-input':
      return <VoiceInputPage />
    case 'settings':
      return <SettingsPage />
    case 'reminders':
      return <ReminderPage />
    case 'characters':
      return <CharacterPage />
    case 'template-card':
      return <TemplateCardPage />
    case 'character-editor':
      return <CharacterEditorPage />
    case 'notebook':
      return <NotebookPage />
    case 'video':
      return <VideoLibraryPage />
    case 'video-player':
      return <VideoPlayerPage />
    case 'video-subtitles':
      return <VideoSubtitlesPage />
    case 'voice-conversation':
      return <VoiceConversationPage />
    case 'status':
      return <StatusPage />
    case 'appearance':
      return <AppearanceSettingsPage />
    case 'bitcoin':
      return <BitcoinPage />
    case 'crypto-events':
      return <CryptoEventCenterPage />
    case 'crypto-provider':
      return <CryptoProviderSettingsPage />
    case 'crypto-chart':
      return <CryptoChartPage />
    case 'timer':
      return <TimerPage />
    case 'remote-video':
      return <RemoteVideoPage />
    case 'remote-site-config':
      return <RemoteSiteConfigPage />
    case 'vault':
      return <VaultPage />
    case 'scripts':
      return <ScriptsPage />
    case 'agent-confirm':
      return <AgentConfirmPage />
    case 'tray-menu':
      return <TrayMenuPage />
    case 'douyin-login':
      return <DouyinLoginPage />
    case 'ui-showcase':
      return <UiShowcasePage />
  }
}
