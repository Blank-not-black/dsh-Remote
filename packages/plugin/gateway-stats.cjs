/* DSH Remote 统计核心 —— 零依赖
 *
 * 事件来源:
 *   - 插件进程实时监听 DSH 'session/event' (assistant/message + usage) -> POST /stats/ingest
 *   - 网关扫描 ~/.dsh/sessions 下的 session.jsonl.zstd 历史回填(启动全量 + 定期增量)
 *
 * 聚合:
 *   time(UTC 毫秒) -> Asia/Shanghai(固定 UTC+8, 无夏令时) -> 日 × 小时 × 模型
 *   时段: 高峰 9:00-12:00 / 14:00-18:00(含起点, 不含终点), 其余空闲
 *   四桶: input(未缓存输入) / cacheRead(缓存命中读) / cacheWrite(缓存写) / output(输出)
 *
 * 存储:
 *   ~/.dsh-remote/stats/days/YYYY-MM-DD.json   按天一个文件, 内含 hours
 *   ~/.dsh-remote/stats/cursors.json           每个 session 已处理的最大 seq(幂等游标)
 *
 * 费用: 固定价格表(元 / 百万 tokens), v2 将改为可配置。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const readline = require('node:readline')

// ---------- 固定价格表(v1 硬编码; v2 将改为配置文件/环境变量) ----------
// 时段判定: 北京时间 9:00-12:00 与 14:00-18:00 为高峰(含起点不含终点)
const PEAK_HOURS = [[9, 12], [14, 18]]
const PRICES = {
  'deepseek-v4-flash': {
    inputCacheHit: { peak: 0.10, off: 0.05 },
    inputMiss: { peak: 3.0, off: 1.5 },
    output: { peak: 9.0, off: 4.5 },
  },
  'deepseek-v4-pro': {
    inputCacheHit: { peak: 0.30, off: 0.15 },
    inputMiss: { peak: 9.0, off: 4.5 },
    output: { peak: 27.0, off: 13.5 },
  },
}
// 缓存写入按未命中输入价计费(DeepSeek 缓存写入以未命中输入计费)
const BUCKET_PRICE_KEY = {
  input: 'inputMiss',
  cacheRead: 'inputCacheHit',
  cacheWrite: 'inputMiss',
  output: 'output',
}

const BJ_OFFSET_MS = 8 * 3600 * 1000
// 定价生效日(北京时间): 2026-08-17 零点更新, 此前的 token 不计入费用统计
const PRICING_START_DATE = '2026-08-17'
const DAYS_DIR = 'days'
const CURSORS_FILE = 'cursors.json'

function pad2(n) { return String(n).padStart(2, '0') }

/** UTC 毫秒 -> 北京小时(0-23)。固定 UTC+8, 不随服务器本地时区。 */
function beijingHour(timeMs) {
  return new Date(timeMs + BJ_OFFSET_MS).getUTCHours()
}

/** UTC 毫秒 -> 北京自然日 'YYYY-MM-DD'。 */
function beijingDate(timeMs) {
  const d = new Date(timeMs + BJ_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** 北京小时 -> 时段。 */
function periodOfHour(hour) {
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return 'peak'
  }
  return 'off'
}

/** 时段单价; 未知模型返回全 0(统计照记, 费用为 0)。 */
function pricesFor(model) {
  return PRICES[model] || null
}

function emptyBucket() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 }
}

function addTokens(bucket, key, tokens) {
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
    bucket[key] += tokens
  }
  return bucket
}

/** 把一个 usage 事件累计进 bucket(含费用)。 */
function addUsage(bucket, model, period, usage) {
  const prices = pricesFor(model)
  const usageObj = usage || {}
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    const tokens = usageObj[key]
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) continue
    bucket[key] += tokens
    if (prices) {
      const priceKey = BUCKET_PRICE_KEY[key]
      bucket.cost += tokens / 1e6 * prices[priceKey][period]
    }
  }
  return bucket
}

function mergeBucket(dst, src) {
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'cost']) {
    dst[key] += src[key]
  }
  return dst
}

/** 时段事件 -> 日/小时/模型聚合的 key。 */
function eventKey(timeMs) {
  return { date: beijingDate(timeMs), hour: beijingHour(timeMs), period: periodOfHour(beijingHour(timeMs)) }
}

/** 事件里的模型: 优先 message.source.model。 */
function eventModel(event) {
  try {
    const m = event?.data?.message?.source?.model
    if (typeof m === 'string' && m) return m
  } catch {}
  return ''
}

function normalizeUsage(event) {
  const u = event?.data?.usage
  if (!u || typeof u !== 'object') return null
  return {
    input: typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens) ? u.inputTokens : 0,
    cacheRead: typeof u.cacheReadTokens === 'number' && Number.isFinite(u.cacheReadTokens) ? u.cacheReadTokens : 0,
    cacheWrite: typeof u.cacheWriteTokens === 'number' && Number.isFinite(u.cacheWriteTokens) ? u.cacheWriteTokens : 0,
    output: typeof u.outputTokens === 'number' && Number.isFinite(u.outputTokens) ? u.outputTokens : 0,
  }
}

/** 汇总一天(hours) -> peak/off/total。 */
function summarizeDay(day) {
  const peak = emptyBucket()
  const off = emptyBucket()
  for (const hourStr of Object.keys(day?.hours || {})) {
    const hour = Number(hourStr)
    const target = periodOfHour(hour) === 'peak' ? peak : off
    for (const model of Object.keys(day.hours[hourStr] || {})) {
      mergeBucket(target, day.hours[hourStr][model])
    }
  }
  const total = emptyBucket()
  mergeBucket(total, peak)
  mergeBucket(total, off)
  return { peak, off, total }
}

function dayTotals(day) {
  const s = summarizeDay(day)
  return s
}

function tokenKeyName(key) {
  return { input: 'input', cacheRead: 'cacheRead', cacheWrite: 'cacheWrite', output: 'output' }[key] || key
}

/** 统计存储: 单文件按天 + 游标。写操作由网关单进程调用, 内部用同步队列串行化。 */
class StatsStore {
  constructor(dir) {
    this.dir = dir || path.join(os.homedir(), '.dsh-remote', 'stats')
    this.daysDir = path.join(this.dir, DAYS_DIR)
    this.cursorsFile = path.join(this.dir, CURSORS_FILE)
    this.cursors = null
    this.queue = Promise.resolve()
    fs.mkdirSync(this.daysDir, { recursive: true })
  }

  _dayFile(date) { return path.join(this.daysDir, `${date}.json`) }

  _loadDay(date) {
    try {
      return JSON.parse(fs.readFileSync(this._dayFile(date), 'utf8'))
    } catch {
      return { date, hours: {} }
    }
  }

  _saveDay(day) {
    const file = this._dayFile(day.date)
    const tmp = file + '.tmp'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(day))
    fs.renameSync(tmp, file)
  }

  _loadCursors() {
    if (this.cursors) return this.cursors
    try {
      this.cursors = JSON.parse(fs.readFileSync(this.cursorsFile, 'utf8'))
    } catch {
      this.cursors = {}
    }
    return this.cursors
  }

  _saveCursors() {
    const tmp = this.cursorsFile + '.tmp'
    fs.mkdirSync(path.dirname(this.cursorsFile), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(this.cursors))
    fs.renameSync(tmp, this.cursorsFile)
  }

  _cursor(sessionId) {
    const c = this._loadCursors()
    const cur = c[sessionId]
    if (cur && typeof cur.lastSeq === 'number') return cur
    return null
  }

  _setCursor(sessionId, lastSeq) {
    const c = this._loadCursors()
    c[sessionId] = { lastSeq, updatedAt: Date.now() }
    this._saveCursors()
  }

  /** 在串行队列里执行统计写操作。 */
  _enqueue(fn) {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => {})
    return run
  }

  /**
   * 处理单个 session 事件(已过滤为 assistant/message 且 usage 有效)。
   * - seq <= cursor: 重复, 跳过
   * - seq === cursor+1: 正常聚合
   * - seq > cursor+1: gap, 不聚合, 等待扫描补漏
   */
  processEvent(sessionId, event, fallbackModel) {
    const seq = typeof event.seq === 'number' ? event.seq : -1
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const usage = normalizeUsage(event)
    if (!usage || seq < 0) return { processed: false, gap: false, skip: true }
    const cur = this._cursor(sessionId)
    const lastSeq = cur ? cur.lastSeq : -1
    if (seq <= lastSeq) return { processed: false, gap: false, skip: true }
    if (seq > lastSeq + 1) return { processed: false, gap: true, skip: true }

    const model = eventModel(event) || fallbackModel || 'unknown'
    const { date, hour, period } = eventKey(time)
    if (date < PRICING_START_DATE) {
      // 定价生效日前的事件不计费，但必须推进游标；否则生效日后的第一条事件会被误判为 gap。
      this._setCursor(sessionId, seq)
      return { processed: false, gap: false, skip: true }
    }
    const day = this._loadDay(date)
    const hourBucket = day.hours[hour] || (day.hours[hour] = {})
    const modelBucket = hourBucket[model] || (hourBucket[model] = emptyBucket())
    addUsage(modelBucket, model, period, usage)
    this._saveDay(day)
    this._setCursor(sessionId, seq)
    return { processed: true, gap: false, skip: false }
  }

  /** 串行化版本(HTTP ingest 用)。 */
  ingestEvent(sessionId, event, fallbackModel) {
    return this._enqueue(() => this.processEvent(sessionId, event, fallbackModel))
  }

  /**
   * 扫描一个 zstd 会话文件, 从游标后顺序处理。返回处理的事件数。
   * 用系统 zstd 命令解压(项目约束: 不新增 npm 运行时依赖; Windows 无 zstd 时跳过)。
   */
  scanFile(file, onProgress) {
    return this._enqueue(() => this._scanFile(file, onProgress))
  }

  _scanFile(file, onProgress) {
    return new Promise((resolvePromise) => {
      const sessionId = path.basename(path.dirname(file))
      const cur = this._cursor(sessionId)
      let lastSeq = cur ? cur.lastSeq : -1
      let processed = 0
      let currentModel = ''
      let headerParsed = false
      let lineCount = 0
      let yielding = false
      const dirtyDays = new Map()
      let scanError = ''
      const flush = () => {
        for (const day of dirtyDays.values()) this._saveDay(day)
        dirtyDays.clear()
        if (lastSeq >= 0) this._setCursor(sessionId, lastSeq)
      }

      const zstd = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] })
      const rl = readline.createInterface({ input: zstd.stdout })

      zstd.on('error', (err) => {
        if (err.code === 'ENOENT') {
          console.warn(`[stats] 未找到 zstd 命令, 跳过历史回填: ${file}`)
        } else {
          console.warn(`[stats] zstd 解压失败 ${file}: ${err.message}`)
        }
        scanError = err.code || err.message
        rl.close()
      })

      rl.on('line', (line) => {
        lineCount++
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        // 首行是 session header, 没有 seq
        if (!headerParsed) {
          headerParsed = true
          return
        }
        if (typeof event.seq !== 'number') return
        if (event.seq <= lastSeq) return
        if (event.seq > lastSeq + 1) {
          // 日志理论上是连续 seq; 出现空洞时以文件为准继续顺序推进(seq 游标按文件顺序)
        }
        // 跟踪当前模型配置: request/header 与 request/context 都可能带模型
        try {
          if (event.type === 'request/header' && event.data?.config?.model) currentModel = event.data.config.model
          if (event.type === 'request/context' && event.data?.model) currentModel = event.data.model
        } catch {}
        if (event.type === 'assistant/message') {
          const usage = normalizeUsage(event)
          if (usage) {
            const model = eventModel(event) || currentModel || 'unknown'
            const { date, hour, period } = eventKey(event.time)
            if (date >= PRICING_START_DATE) {
              const day = dirtyDays.get(date) || this._loadDay(date)
              dirtyDays.set(date, day)
              const hourBucket = day.hours[hour] || (day.hours[hour] = {})
              const modelBucket = hourBucket[model] || (hourBucket[model] = emptyBucket())
              addUsage(modelBucket, model, period, usage)
              processed++
            }
          }
        }
        lastSeq = event.seq
        // 大历史文件按批次让出事件循环，避免回填长期占住实时 HTTP/WS 处理。
        if (lineCount % 500 === 0 && !yielding) {
          yielding = true
          rl.pause()
          setImmediate(() => { yielding = false; rl.resume() })
        }
      })

      rl.on('close', () => {
        flush()
        if (onProgress) onProgress({ sessionId, processed })
        resolvePromise({ sessionId, processed, ...(scanError ? { error: scanError } : {}) })
      })
    })
  }

  /** 扫描 ~/.dsh/sessions 下全部 session.jsonl.zstd。 */
  async scanAll(sessionsRoot, onProgress) {
    const root = sessionsRoot || path.join(os.homedir(), '.dsh', 'sessions')
    let files = []
    try {
      const walk = async (dir) => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true })
        for (const ent of entries) {
          if (ent.isDirectory()) await walk(path.join(dir, ent.name))
          else if (ent.name === 'session.jsonl.zstd') files.push(path.join(dir, ent.name))
        }
      }
      await walk(root)
    } catch (err) {
      console.warn('[stats] 扫描会话目录失败: ' + (err.message || err))
      return { files: 0, processed: 0 }
    }
    let processed = 0
    // 串行扫描, 避免大量并发 zstd 子进程
    for (const file of files) {
      const out = await this.scanFile(file, onProgress)
      processed += out.processed || 0
    }
    return { files: files.length, processed }
  }

  summary(days) {
    const n = Math.max(1, Math.min(Number(days) || 7, 90))
    const out = []
    // 查询窗口起点: 不早于定价生效日(生效日之前不统计)
    const today = beijingDate(Date.now())
    const startD = new Date(Date.now() + BJ_OFFSET_MS)
    startD.setUTCDate(startD.getUTCDate() - (n - 1))
    const windowStart = `${startD.getUTCFullYear()}-${pad2(startD.getUTCMonth() + 1)}-${pad2(startD.getUTCDate())}`
    const first = windowStart > PRICING_START_DATE ? windowStart : PRICING_START_DATE
    const [fy, fm, fd] = first.split('-').map(Number)
    for (let cur = Date.UTC(fy, fm - 1, fd); ; cur += 86400_000) {
      const date = beijingDate(cur)
      if (date > today) break
      const day = this._loadDay(date)
      const s = dayTotals(day)
      const byModel = {}
      for (const hourStr of Object.keys(day.hours || {})) {
        const period = periodOfHour(Number(hourStr))
        for (const [model, bucket] of Object.entries(day.hours[hourStr])) {
          const m = byModel[model] || (byModel[model] = { peak: emptyBucket(), off: emptyBucket(), total: emptyBucket() })
          mergeBucket(m[period], bucket)
          mergeBucket(m.total, bucket)
        }
      }
      out.push({ date, ...s, byModel })
    }
    return out
  }

  detail(date) {
    // 生效日前不返回统计(页面会展示空态与生效日提示)
    const effective = date >= PRICING_START_DATE ? date : PRICING_START_DATE
    const day = this._loadDay(effective)
    const hours = []
    for (let hour = 0; hour < 24; hour++) {
      const models = day.hours[hour] || {}
      const total = emptyBucket()
      for (const bucket of Object.values(models)) mergeBucket(total, bucket)
      hours.push({ hour, period: periodOfHour(hour), models, total })
    }
    return { date: effective, pricingStart: PRICING_START_DATE, hours }
  }
}

module.exports = {
  BJ_OFFSET_MS,
  PRICING_START_DATE,
  PEAK_HOURS,
  PRICES,
  beijingHour,
  beijingDate,
  periodOfHour,
  emptyBucket,
  addUsage,
  summarizeDay,
  dayTotals,
  eventKey,
  eventModel,
  normalizeUsage,
  StatsStore,
}
