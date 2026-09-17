/**
 * 单日统计（/stats/summary 的 days[] 项）。
 */
export class StatsDay {
  date: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  peakCost: number
  offCost: number

  constructor(date: string, input: number, cacheRead: number, cacheWrite: number,
    output: number, peakCost: number, offCost: number) {
    this.date = date
    this.input = input
    this.cacheRead = cacheRead
    this.cacheWrite = cacheWrite
    this.output = output
    this.peakCost = peakCost
    this.offCost = offCost
  }

  tokens(): number {
    return this.input + this.cacheRead + this.cacheWrite + this.output
  }

  totalCost(): number {
    return this.peakCost + this.offCost
  }

  static fromRecord(r: Record<string, Object>): StatsDay {
    const total = r['total'] as Record<string, Object> ?? {}
    const peak = r['peak'] as Record<string, Object> ?? {}
    const off = r['off'] as Record<string, Object> ?? {}
    return new StatsDay(
      String(r['date'] ?? ''),
      Number(total['input'] ?? 0),
      Number(total['cacheRead'] ?? 0),
      Number(total['cacheWrite'] ?? 0),
      Number(total['output'] ?? 0),
      Number(peak['cost'] ?? 0),
      Number(off['cost'] ?? 0)
    )
  }

  static fromArray(arr: Array<Record<string, Object>>): StatsDay[] {
    const list: StatsDay[] = []
    for (const item of arr) {
      list.push(StatsDay.fromRecord(item))
    }
    return list
  }
}