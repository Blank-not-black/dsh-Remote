/**
 * 待处理事项：工具审批与用户提问（mux 通道事件）。
 */
export class PendingApproval {
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  summary: string

  constructor(rpcId: string, sessionId: string, approvalId: string, toolName: string, summary: string) {
    this.rpcId = rpcId
    this.sessionId = sessionId
    this.approvalId = approvalId
    this.toolName = toolName
    this.summary = summary
  }
}

export class PendingQuestion {
  rpcId: string
  sessionId: string
  questions: Array<Record<string, Object>>
  title: string

  constructor(rpcId: string, sessionId: string, questions: Array<Record<string, Object>>, title: string) {
    this.rpcId = rpcId
    this.sessionId = sessionId
    this.questions = questions
    this.title = title
  }
}