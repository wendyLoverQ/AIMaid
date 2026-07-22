import type { CoreRequest } from './core'

interface AgentDecision {
  conversationId: string
  type: string
  message: string
  voiceStyle: string
  capability: string
  argsJson: string
  reason: string
  timeText: string
  content: string
  repeat: string
  messageId: number
}

export interface AgentConversationResult {
  conversationId: string
  messageId: number
  content: string
  voiceStyle: string
  suppressSpeech: boolean
}

export interface AgentConversationOptions {
  conversationId?: string
  characterId?: string
  continueConversation?: boolean
  source: string
}

export interface AgentCoreResponse {
  success: boolean
  payload: unknown
  error?: { message: string } | null
}

export type AgentCoreInvoker = (request: CoreRequest, timeoutMs?: number) => Promise<AgentCoreResponse>

export async function runAgentConversation(
  content: string,
  options: AgentConversationOptions,
  invokeCore: AgentCoreInvoker
): Promise<AgentConversationResult> {
  const maxSteps = 4
  let conversationId = options.conversationId
  let toolResultJson: string | undefined
  let suppressSpeech = false
  for (let step = 1; step <= maxSteps; step += 1) {
    const response = await invokeCore({ type: 'agent.decide', payload: {
      content,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(options.characterId === undefined ? {} : { characterId: options.characterId }),
      saveUserMessage: step === 1,
      ...(toolResultJson === undefined ? {} : { toolResultJson }),
      toolStep: step,
      maxSteps,
      source: options.source,
      continueConversation: options.continueConversation ?? false
    } }, 120000)
    if (!response.success) throw new Error(response.error?.message ?? 'Agent 决策失败。')
    const decision = response.payload as AgentDecision | null
    if (decision === null || decision.conversationId === '') throw new Error('Agent 返回了无效决策。')
    conversationId = decision.conversationId
    if (['final_response', 'final_answer', 'ask_user', 'ask_clarify', 'reject'].includes(decision.type)) {
      return {
        conversationId,
        messageId: decision.messageId,
        content: decision.message,
        voiceStyle: decision.voiceStyle || 'normal',
        suppressSpeech
      }
    }

    let capability = decision.capability
    let argsJson = decision.argsJson || '{}'
    if (decision.type === 'reminder_create') {
      capability = 'reminder.create'
      argsJson = JSON.stringify({ timeText: decision.timeText, content: decision.content || content, repeat: decision.repeat || 'none' })
    } else if (decision.type !== 'tool_call') {
      throw new Error(`Agent 返回了不支持的决策类型：${decision.type}`)
    }
    if (capability === '') throw new Error('Agent 没有返回要执行的能力。')
    const tool = await invokeCore({ type: 'agent.execute', payload: { conversationId, capabilityName: capability, argsJson } }, 120000)
    if (!tool.success) throw new Error(tool.error?.message ?? `Agent 能力执行失败：${capability}`)
    const toolPayload = tool.payload as { resultPolicy?: unknown } | null
    suppressSpeech ||= toolPayload?.resultPolicy === 'silent'
    toolResultJson = JSON.stringify({ type: 'tool_result', capabilityName: capability, result: tool.payload })
  }
  throw new Error('Agent 已达到最大执行步数。')
}
