/**
 * RPC 载荷接口（ArkTS 要求对象字面量对应显式 interface）。
 * 字段与 docs/modules/01-contracts.md 对齐。
 */
export interface TextBlock {
  type: string
  text: string
}

export interface ImageBlock {
  type: string
  mediaType: string
  data: string
  name?: string
}

export interface SessionHistoryPayload {
  sessionId: string
  maxMessages: number
}

export interface SessionModelsPayload {
  sessionId: string
}

/** session.cancel：中断当前正在运行的一轮 */
export interface SessionCancelPayload {
  sessionId: string
}

/** session.rename：会话重命名 */
export interface SessionRenamePayload {
  sessionId: string
  title: string
}

/** session.create：创建会话（workspaceId 可选，指定新会话的工作区） */
export interface SessionCreatePayload {
  workspaceId?: string
}

export interface SessionPromptPayload {
  sessionId: string
  mode: string
  content: Array<TextBlock | ImageBlock>
}

export interface SelectModelPayload {
  sessionId: string
  provider: string
  model: string
  reasoningEffort?: string
}

/** 审批应答 value：{ sessionId, approvalId, outcome } */
export interface ApproveValue {
  sessionId: string
  approvalId: string
  outcome: string
}

export interface AnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface AnswerBody {
  answers: Array<AnswerItem>
}

/** 提问应答 value：{ sessionId, answer } */
export interface AnswerValue {
  sessionId: string
  answer: AnswerBody
}