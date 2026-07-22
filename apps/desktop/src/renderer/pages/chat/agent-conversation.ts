import { bridge } from '../../shared/bridge'
import {
  runAgentConversation as runSharedAgentConversation,
  type AgentConversationOptions,
  type AgentConversationResult
} from '../../../shared/agent-conversation'

export type { AgentConversationResult } from '../../../shared/agent-conversation'

export async function runAgentConversation(content: string, options: AgentConversationOptions): Promise<AgentConversationResult> {
  return runSharedAgentConversation(content, options, bridge.core.invoke)
}
