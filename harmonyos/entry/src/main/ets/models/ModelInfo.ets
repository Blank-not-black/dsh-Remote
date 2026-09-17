/**
 * 会话模型数据（session.models 响应解析）。
 * reasoning.efforts 为自定义档位；无自定义时兼容 low/high/max。
 */
export class EffortOption {
  id: string
  name: string
  description: string

  constructor(id: string, name: string, description: string) {
    this.id = id
    this.name = name
    this.description = description
  }
}

export class ModelEntry {
  id: string
  name: string
  efforts: EffortOption[]
  defaultEffort: string

  constructor(id: string, name: string, efforts: EffortOption[], defaultEffort: string) {
    this.id = id
    this.name = name
    this.efforts = efforts
    this.defaultEffort = defaultEffort
  }

  static fromRecord(r: Record<string, Object>): ModelEntry {
    const id = String(r['id'] ?? '')
    const name = String(r['name'] ?? id)
    const reasoning = r['reasoning'] as Record<string, Object> ?? {}
    const rawEfforts = reasoning['efforts'] as Array<Record<string, Object>> ?? []
    const efforts: EffortOption[] = []
    for (const e of rawEfforts) {
      const eid = String(e['id'] ?? '')
      const ename = String(e['name'] ?? eid)
      const edesc = String(e['description'] ?? '')
      efforts.push(new EffortOption(eid, ename, edesc))
    }
    const defaultEffort = String(reasoning['defaultEffort'] ??
      (efforts.length > 0 ? efforts[0].id : ''))
    return new ModelEntry(id, name, efforts, defaultEffort)
  }

  /** 展示用档位列表：自定义优先，否则兼容 low/high/max */
  effortOptions(): EffortOption[] {
    if (this.efforts.length > 0) {
      return this.efforts
    }
    return [
      new EffortOption('low', '低', '低延迟'),
      new EffortOption('high', '高', '更多推理'),
      new EffortOption('max', '最高', '充分推理')
    ]
  }

  isCurrentEffort(effortId: string, current: string): boolean {
    if (current.length > 0) {
      return current === effortId
    }
    return this.defaultEffort === effortId
  }
}

export class ModelGroup {
  id: string
  name: string
  models: ModelEntry[]

  constructor(id: string, name: string, models: ModelEntry[]) {
    this.id = id
    this.name = name
    this.models = models
  }

  static fromRecord(r: Record<string, Object>): ModelGroup {
    const id = String(r['id'] ?? '')
    const name = String(r['name'] ?? id)
    const rawModels = r['models'] as Array<Record<string, Object>> ?? []
    const models: ModelEntry[] = []
    for (const m of rawModels) {
      models.push(ModelEntry.fromRecord(m))
    }
    return new ModelGroup(id, name, models)
  }
}

export class CurrentModel {
  provider: string
  model: string
  reasoningEffort: string

  constructor(provider: string, model: string, reasoningEffort: string) {
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
  }

  static fromRecord(r: Record<string, Object>): CurrentModel {
    return new CurrentModel(
      String(r['provider'] ?? ''),
      String(r['model'] ?? ''),
      String(r['reasoningEffort'] ?? '')
    )
  }

  static fromObject(v: Object): CurrentModel {
    return CurrentModel.fromRecord(v as Record<string, Object> ?? {})
  }
}