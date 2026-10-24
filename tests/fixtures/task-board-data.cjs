const task = { id: 'task-fixture', title: '检查候选包', description: '确认测试与安装结果', prompt: 'SECRET PROMPT', workspaceId: 'workspace-fixture', status: 'failed', updatedAt: 1792710000000,
  executions: [{ id: 'run-fixture', sessionId: 'insights-session', startedAt: 1792700000000, endedAt: 1792710000000, result: 'failed', error: '缺少验收证据',
    summary: { text: '实现已完成，验收仍需补充' }, verification: { applicability: 'enforced', inFlight: false, failedReason: '未通过本次检查', attempts: [{ stage: 'quality', passed: false, findings: ['SECRET INTERNAL'] }] } }],
  schedule: { enabled: true, mode: 'cron', cron: '0 9 * * 1-5', timeZone: 'Asia/Shanghai', nextRunAt: 1792794000000, runCount: 3 }, handover: { token: 'SECRET' } }
const snapshot = { schemaVersion: 6, revision: 7, scheduler: { timeZone: 'Asia/Shanghai', error: 'SECRET' }, tasks: [task,
  { ...task, id: 'other', title: '其他工作区任务', workspaceId: 'workspace-other' },
  { ...task, id: 'unassigned', title: '未绑定任务', workspaceId: undefined },
  { ...task, id: 'hidden', title: '隐藏任务', hidden: true },
] }
module.exports = { task, snapshot }
