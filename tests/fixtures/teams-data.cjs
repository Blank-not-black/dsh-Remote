module.exports = { teams: [
  { teamId: 'team-fixture', name: '功能验证团队', workspace: '同名工作区', captainSessionId: 'insights-session', phase: 'running', planReviewState: 'awaiting_review', deliverable: false,
    delivery: { ok: false, blockers: ['等待检查结果'], warnings: ['尚未完成目标设备验收'] },
    members: [{ id: 'child-fixture', name: '开发成员', role: '实现与自测', status: 'idle', activity: 'idle', provider: 'fixture', model: 'fixture-model', currentTask: 'verify', executionPrompt: 'SECRET SYSTEM PROMPT' }],
    tasks: [{ id: 'build', subject: '实现', description: '完成改动', status: 'in_progress', state: 'running', dependencies: [], assignee: '开发成员' },
      { id: 'verify', subject: '验证', description: '核对所有操作路径', status: 'pending', state: 'blocked', dependencies: ['build'], assignee: '开发成员' }],
    messageCount: 1, captainInbox: [{ from: '开发成员', content: '等待独立检查，请确认结果。' }] },
  { teamId: 'team-other', name: '其他工作区团队，不可泄漏', workspace: '同名工作区', captainSessionId: 'other-captain', members: [], tasks: [] }
] }
