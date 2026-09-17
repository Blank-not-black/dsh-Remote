/**
 * 公告与投票模型（对应 Web 端 announcements.json + /feedback poll）。
 */
export class PollOption {
  id: string
  label: string
  description: string

  constructor(id: string, label: string, description: string) {
    this.id = id
    this.label = label
    this.description = description
  }
}

export class AnnouncementPoll {
  id: string
  question: string
  options: PollOption[]

  constructor(id: string, question: string, options: PollOption[]) {
    this.id = id
    this.question = question
    this.options = options
  }
}

export class Announcement {
  id: string
  title: string
  content: string
  publishedAt: number
  expiresAt: number
  actionUrl: string
  actionText: string
  force: boolean
  poll: AnnouncementPoll | null

  constructor(id: string, title: string, content: string, publishedAt: number, expiresAt: number,
    actionUrl: string, actionText: string, force: boolean, poll: AnnouncementPoll | null) {
    this.id = id
    this.title = title
    this.content = content
    this.publishedAt = publishedAt
    this.expiresAt = expiresAt
    this.actionUrl = actionUrl
    this.actionText = actionText
    this.force = force
    this.poll = poll
  }

  static fromRecord(r: Record<string, Object>): Announcement | null {
    const id = String(r['id'] ?? '')
    if (id.length === 0) {
      return null
    }
    const publishedAt = Announcement.toTs(r['publishedAt'])
    const expiresAt = Announcement.toTs(r['expiresAt'])
    const rawPoll = r['poll'] as Record<string, Object> ?? null
    let poll: AnnouncementPoll | null = null
    if (rawPoll) {
      const options: PollOption[] = []
      const rawOptions = rawPoll['options'] as Array<Record<string, Object>> ?? []
      for (const o of rawOptions) {
        options.push(new PollOption(
          String(o['id'] ?? ''),
          String(o['label'] ?? ''),
          String(o['description'] ?? '')
        ))
      }
      poll = new AnnouncementPoll(
        String(rawPoll['id'] ?? ''),
        String(rawPoll['question'] ?? ''),
        options
      )
    }
    return new Announcement(
      id,
      String(r['title'] ?? ''),
      String(r['content'] ?? ''),
      publishedAt,
      expiresAt,
      String(r['actionUrl'] ?? ''),
      String(r['actionText'] ?? ''),
      r['force'] === true,
      poll
    )
  }

  /** 时间字段兼容数字时间戳与 ISO 字符串 */
  static toTs(v: Object): number {
    if (v === null) {
      return 0
    }
    const n = Number(v)
    if (!Number.isNaN(n) && n > 0) {
      return n
    }
    const t = Date.parse(String(v))
    if (!Number.isNaN(t)) {
      return t
    }
    return 0
  }

  /** 序列化（公告历史持久化用；poll 一并保留） */
  toRecord(): Record<string, Object> {
    const r: Record<string, Object> = {
      'id': this.id,
      'title': this.title,
      'content': this.content,
      'publishedAt': this.publishedAt,
      'expiresAt': this.expiresAt,
      'actionUrl': this.actionUrl,
      'actionText': this.actionText,
      'force': this.force
    }
    if (this.poll) {
      const opts: Array<Record<string, Object>> = []
      for (const o of this.poll.options) {
        const or: Record<string, Object> = {
          'id': o.id,
          'label': o.label,
          'description': o.description
        }
        opts.push(or)
      }
      const pr: Record<string, Object> = {
        'id': this.poll.id,
        'question': this.poll.question,
        'options': opts
      }
      r['poll'] = pr
    }
    return r
  }

  static toJsonArray(list: Announcement[]): string {
    const arr: Array<Record<string, Object>> = []
    for (const a of list) {
      arr.push(a.toRecord())
    }
    return JSON.stringify(arr)
  }

  static fromJsonArray(json: string): Announcement[] {
    const out: Announcement[] = []
    if (json.length === 0) {
      return out
    }
    try {
      const arr = JSON.parse(json) as Array<Record<string, Object>>
      if (!Array.isArray(arr)) {
        return out
      }
      for (const r of arr) {
        const a = Announcement.fromRecord(r)
        if (a) {
          out.push(a)
        }
      }
    } catch (e) {
      // 损坏的本地历史按空处理
    }
    return out
  }
}