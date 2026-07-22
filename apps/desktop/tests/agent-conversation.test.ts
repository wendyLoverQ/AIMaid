import { describe, expect, it } from 'vitest'
import { runAgentConversation, type AgentCoreResponse } from '../src/shared/agent-conversation'
import type { CoreRequest } from '../src/shared/core'

describe('agent conversation result policy', () => {
  it('suppresses speech when an executed capability is configured as silent', async () => {
    const responses: AgentCoreResponse[] = [
      { success: true, payload: decision('tool_call', '', 'music.search') },
      { success: true, payload: { status: 'completed', output: '正在播放：测试歌曲', resultPolicy: 'silent' } },
      { success: true, payload: decision('final_response', '正在播放：测试歌曲') }
    ]

    const result = await runAgentConversation('播放测试歌曲', { source: 'normal_chat' }, mockInvoker(responses))

    expect(result.suppressSpeech).toBe(true)
    expect(result.content).toBe('正在播放：测试歌曲')
  })

  it('keeps ordinary final responses speakable', async () => {
    const result = await runAgentConversation('你好', { source: 'normal_chat' }, mockInvoker([
      { success: true, payload: decision('final_response', '你好，主人。') }
    ]))

    expect(result.suppressSpeech).toBe(false)
  })
})

function decision(type: string, message: string, capability = ''): object {
  return {
    conversationId: 'conversation_1', type, message, voiceStyle: 'normal', capability,
    argsJson: '{}', reason: '', timeText: '', content: '', repeat: '', messageId: 1
  }
}

function mockInvoker(responses: AgentCoreResponse[]): (request: CoreRequest, timeoutMs?: number) => Promise<AgentCoreResponse> {
  return async () => responses.shift() ?? { success: false, payload: null, error: { message: 'unexpected request' } }
}
