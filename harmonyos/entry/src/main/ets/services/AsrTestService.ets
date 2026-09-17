import { speechRecognizer } from '@kit.CoreSpeechKit'
import { audio } from '@kit.AudioKit'
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { Logger } from '../common/Logger'
import { StorageService } from './StorageService'

/**
 * 语音识别诊断（对应 Android AsrTestBridge）：Core Speech Kit 离线中文识别，
 * 60 秒短语音测试，观察 partial / final / 错误与恢复表现。
 *
 * 与 Android 端 SpeechRecognizer 的差异：
 *   - Android 走系统云端识别服务（小米设备常为云端），partial 表现取决于厂商服务；
 *     HarmonyOS Core Speech Kit 为**离线模型**（中文普通话，短语音 ≤60s）。
 *   - HarmonyOS 引擎不自带拾音，需要应用侧用 AudioCapturer 采 16kHz/16bit/单声道
 *     PCM，按 640/1280 字节块喂 writeAudio（官方约束：音频流长度仅支持 640 或 1280）。
 *   - 测试结果只在本页展示，不上传报告（与 Android 端一致）。
 *
 * 文档出处：
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/speechrecognizer-guide
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/using-audiocapturer-for-recording
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-references/hms-ai-speechrecognizer
 */

/** 单条测试事件（对齐 Android AsrTestBridge emit 的事件流结构） */
export interface AsrEvent {
  type: string
  atMs: number
  data: Record<string, Object>
}

/** ASR 错误码 → 名称（官方 hms-ai-speechrecognizer 错误码说明） */
function asrErrorName(code: number): string {
  if (code === 1002200001) {
    return 'ENGINE_CREATE_FAIL'
  }
  if (code === 1002200002) {
    return 'ENGINE_BUSY'
  }
  if (code === 1002200003) {
    return 'ENGINE_ALREADY_CREATED'
  }
  if (code === 1002200004) {
    return 'INVALID_PARAM'
  }
  if (code === 1002200005) {
    return 'AUDIO_ERROR'
  }
  if (code === 1002200006) {
    return 'ENGINE_BUSY_OTHER_APP'
  }
  if (code === 1002200007) {
    return 'SERVER_ERROR'
  }
  if (code === 1002200008) {
    return 'ENGINE_DESTROYED'
  }
  return 'ERROR_' + code.toString()
}

/** 音频源：语音识别场景用 SOURCE_TYPE_VOICE_RECOGNITION */
const SAMPLE_RATE = audio.AudioSamplingRate.SAMPLE_RATE_16000
const CHANNEL = audio.AudioChannel.CHANNEL_1
const FORMAT = audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE
/** writeAudio 只接受 640/1280 字节块 */
const WRITE_CHUNK = 1280

export class AsrTestService {
  private static ctx: common.UIAbilityContext | null = null
  private static engine: speechRecognizer.SpeechRecognitionEngine | null = null
  private static capturer: audio.AudioCapturer | null = null
  private static events: AsrEvent[] = []
  private static running: boolean = false
  private static sessionId: string = 'dsh-asr-1'
  private static sessionSeq: number = 0
  private static startedAt: number = 0
  private static sessionStartedAt: number = 0
  private static partialCount: number = 0
  private static finalCount: number = 0
  private static errorCount: number = 0
  private static firstPartialMs: number = -1
  private static firstFinalMs: number = -1
  private static deadlineTimer: number = -1
  /** 测试时长上限（毫秒），对齐 Android TEST_DURATION_MS */
  private static readonly TEST_DURATION_MS = 60000
  private static listener: ((events: AsrEvent[]) => void) | null = null

  static isRunning(): boolean {
    return AsrTestService.running
  }

  static getEvents(): AsrEvent[] {
    return AsrTestService.events
  }

  /** 清空事件流（页面"清空日志"按钮用） */
  static clearEvents(): void {
    AsrTestService.events = []
    if (AsrTestService.listener) {
      AsrTestService.listener(AsrTestService.events)
    }
  }

  /** 页面订阅事件流（进入页面时注册，返回去重后的引用增量） */
  static setListener(listener: ((events: AsrEvent[]) => void) | null): void {
    AsrTestService.listener = listener
  }

  private static emit(type: string, data: Record<string, Object>): void {
    const event: AsrEvent = { type: type, atMs: AsrTestService.elapsedMs(), data: data }
    AsrTestService.events.push(event)
    if (AsrTestService.events.length > 500) {
      AsrTestService.events.splice(0, AsrTestService.events.length - 500)
    }
    if (AsrTestService.listener) {
      AsrTestService.listener(AsrTestService.events)
    }
  }

  private static elapsedMs(): number {
    return AsrTestService.startedAt <= 0 ? 0 : Date.now() - AsrTestService.startedAt
  }

  private static status(status: string, message: string, session?: string, reason?: string): void {
    const data: Record<string, Object> = { 'status': status, 'message': message }
    if (session !== undefined) {
      data['session'] = session
    }
    if (reason !== undefined && reason.length > 0) {
      data['reason'] = reason
    }
    AsrTestService.emit('status', data)
  }

  /** 请求麦克风权限（module.json5 已声明 MICROPHONE） */
  static async requestMicPermission(): Promise<boolean> {
    const ctx = AsrTestService.ensureContext()
    if (!ctx) {
      return false
    }
    try {
      const atManager = abilityAccessCtrl.createAtManager()
      const result = await atManager.requestPermissionsFromUser(ctx,
        ['ohos.permission.MICROPHONE'] as Array<Permissions>)
      for (const r of result.authResults) {
        if (r !== 0) {
          return false
        }
      }
      return true
    } catch (e) {
      Logger.warn('mic permission failed: ' + (e as BusinessError).message)
      return false
    }
  }

  /** 开始一次 60s 测试：创建引擎 → 设置回调 → 采集并喂音频流 */
  static async startTest(): Promise<boolean> {
    if (AsrTestService.running) {
      AsrTestService.status('busy', '已有 ASR 测试正在运行')
      return false
    }
    const granted = await AsrTestService.requestMicPermission()
    if (!granted) {
      AsrTestService.status('permission-denied', '未授予麦克风权限，请到系统设置开启')
      return false
    }
    AsrTestService.resetState()
    AsrTestService.running = true
    AsrTestService.startedAt = Date.now()
    AsrTestService.emit('meta', AsrTestService.buildMeta())
    AsrTestService.status('starting', '开始 Core Speech Kit 离线中文识别测试')

    const created = await AsrTestService.createEngine()
    if (!created) {
      AsrTestService.finish('engine-create-failed')
      return false
    }
    const captureStarted = await AsrTestService.startCapture()
    if (!captureStarted) {
      AsrTestService.finish('capture-start-failed')
      return false
    }
    // 60s 死线到点自动结束
    AsrTestService.deadlineTimer = setTimeout(() => {
      AsrTestService.finish('test-duration-reached')
    }, AsrTestService.TEST_DURATION_MS)
    AsrTestService.status('listening', '正在监听，请朗读中文测试内容')
    return true
  }

  /** 用户手动停止 */
  static stopTest(): void {
    AsrTestService.finish('user-stopped')
  }

  private static resetState(): void {
    AsrTestService.events = []
    AsrTestService.sessionSeq = 0
    AsrTestService.partialCount = 0
    AsrTestService.finalCount = 0
    AsrTestService.errorCount = 0
    AsrTestService.firstPartialMs = -1
    AsrTestService.firstFinalMs = -1
    if (AsrTestService.deadlineTimer >= 0) {
      clearTimeout(AsrTestService.deadlineTimer)
      AsrTestService.deadlineTimer = -1
    }
  }

  private static buildMeta(): Record<string, Object> {
    const data: Record<string, Object> = {
      'recognizerMode': 'short',
      'language': 'zh-CN',
      'online': 1,
      'modelType': 'offline',
      'maxDurationMs': AsrTestService.TEST_DURATION_MS,
      'sampleRate': 16000,
      'channel': 1,
      'sampleBit': 16
    }
    return data
  }

  private static ensureContext(): common.UIAbilityContext | null {
    if (!AsrTestService.ctx) {
      AsrTestService.ctx = StorageService.getContext()
    }
    return AsrTestService.ctx
  }

  private static createEngine(): Promise<boolean> {
    return new Promise<boolean>((resolve: (ok: boolean) => void) => {
      const extraParam: Record<string, Object> = { 'locate': 'CN', 'recognizerMode': 'short' }
      const initParamsInfo: speechRecognizer.CreateEngineParams = {
        language: 'zh-CN',
        online: 1,
        extraParams: extraParam
      }
      try {
        speechRecognizer.createEngine(initParamsInfo,
          (err: BusinessError, speechRecognitionEngine: speechRecognizer.SpeechRecognitionEngine) => {
            if (err) {
              const data: Record<string, Object> = {
                'name': asrErrorName(err.code),
                'code': err.code,
                'message': err.message
              }
              AsrTestService.emit('error', data)
              resolve(false)
              return
            }
            AsrTestService.engine = speechRecognitionEngine
            AsrTestService.attachEngineListener()
            resolve(true)
          })
      } catch (e) {
        const err = e as BusinessError
        const data: Record<string, Object> = {
          'name': asrErrorName(err.code),
          'code': err.code,
          'message': err.message
        }
        AsrTestService.emit('error', data)
        resolve(false)
      }
    })
  }

  private static attachEngineListener(): void {
    if (!AsrTestService.engine) {
      return
    }
    const listener: speechRecognizer.RecognitionListener = {
      onStart: (sessionId: string, eventMessage: string) => {
        AsrTestService.sessionStartedAt = Date.now()
        AsrTestService.status('listening', '识别 session 开始', sessionId, eventMessage)
      },
      onEvent: (sessionId: string, eventCode: number, eventMessage: string) => {
        const data: Record<string, Object> = {
          'session': sessionId,
          'eventCode': eventCode,
          'message': eventMessage
        }
        AsrTestService.emit('callback', data)
      },
      onResult: (sessionId: string, result: speechRecognizer.SpeechRecognitionResult) => {
        const isFinal = result.isLast === true
        if (isFinal) {
          AsrTestService.finalCount++
          if (AsrTestService.firstFinalMs < 0) {
            AsrTestService.firstFinalMs = AsrTestService.elapsedMs()
          }
        } else {
          AsrTestService.partialCount++
          if (AsrTestService.firstPartialMs < 0) {
            AsrTestService.firstPartialMs = AsrTestService.elapsedMs()
          }
        }
        const data: Record<string, Object> = {
          'session': sessionId,
          'type': isFinal ? 'final' : 'partial',
          'count': isFinal ? AsrTestService.finalCount : AsrTestService.partialCount,
          'text': result.result
        }
        AsrTestService.emit(isFinal ? 'final' : 'partial', data)
        // 短语音模式：一条 final 表示本轮识别结束，结束整次测试
        if (isFinal) {
          AsrTestService.finish('final-received')
        }
      },
      onComplete: (sessionId: string, eventMessage: string) => {
        AsrTestService.status('complete', '识别完成', sessionId, eventMessage)
      },
      onError: (sessionId: string, errorCode: number, errorMessage: string) => {
        AsrTestService.errorCount++
        const data: Record<string, Object> = {
          'session': sessionId,
          'code': errorCode,
          'name': asrErrorName(errorCode),
          'message': errorMessage
        }
        AsrTestService.emit('error', data)
        AsrTestService.finish('error:' + asrErrorName(errorCode))
      }
    }
    AsrTestService.engine.setListener(listener)
  }

  /** 创建 AudioCapturer 并开始采集；readData 回调里切块喂 writeAudio */
  private static async startCapture(): Promise<boolean> {
    const streamInfo: audio.AudioStreamInfo = {
      samplingRate: SAMPLE_RATE,
      channels: CHANNEL,
      sampleFormat: FORMAT,
      encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
    }
    const capturerInfo: audio.AudioCapturerInfo = {
      source: audio.SourceType.SOURCE_TYPE_VOICE_RECOGNITION,
      capturerFlags: 0
    }
    const options: audio.AudioCapturerOptions = {
      streamInfo: streamInfo,
      capturerInfo: capturerInfo
    }
    return new Promise<boolean>((resolve: (ok: boolean) => void) => {
      try {
        audio.createAudioCapturer(options, (err: BusinessError, capturer: audio.AudioCapturer) => {
          if (err) {
            const data: Record<string, Object> = {
              'name': 'CAPTURE_CREATE_FAIL',
              'code': err.code,
              'message': err.message
            }
            AsrTestService.emit('error', data)
            resolve(false)
            return
          }
          AsrTestService.capturer = capturer
          capturer.on('readData', (buffer: ArrayBuffer) => {
            AsrTestService.feedAudio(buffer)
          })
          capturer.start().then(() => {
            resolve(true)
          }).catch((startErr: BusinessError) => {
            const data: Record<string, Object> = {
              'name': 'CAPTURE_START_FAIL',
              'code': startErr.code,
              'message': startErr.message
            }
            AsrTestService.emit('error', data)
            resolve(false)
          })
        })
      } catch (e) {
        const err = e as BusinessError
        const data: Record<string, Object> = {
          'name': 'CAPTURE_CREATE_FAIL',
          'code': err.code,
          'message': err.message
        }
        AsrTestService.emit('error', data)
        resolve(false)
      }
    })
  }

  /** 把采集缓冲按 1280 字节切块喂给引擎（writeAudio 只接受 640/1280） */
  private static feedAudio(buffer: ArrayBuffer): void {
    if (!AsrTestService.engine || !AsrTestService.running) {
      return
    }
    const bytes = new Uint8Array(buffer)
    for (let offset = 0; offset + WRITE_CHUNK <= bytes.length; offset += WRITE_CHUNK) {
      const chunk = bytes.slice(offset, offset + WRITE_CHUNK)
      try {
        AsrTestService.engine.writeAudio(AsrTestService.sessionId, chunk)
      } catch (e) {
        const err = e as BusinessError
        const data: Record<string, Object> = {
          'name': 'WRITE_AUDIO_FAIL',
          'code': err.code,
          'message': err.message
        }
        AsrTestService.emit('error', data)
        return
      }
    }
  }

  /** 结束测试：停采集 → finish/cancel + shutdown 引擎 → 发 summary */
  private static finish(reason: string): void {
    if (!AsrTestService.running) {
      return
    }
    AsrTestService.running = false
    if (AsrTestService.deadlineTimer >= 0) {
      clearTimeout(AsrTestService.deadlineTimer)
      AsrTestService.deadlineTimer = -1
    }
    const cap = AsrTestService.capturer
    AsrTestService.capturer = null
    if (cap) {
      try {
        cap.stop()
        cap.release()
      } catch (e) {
        Logger.warn('capturer release failed: ' + (e as BusinessError).message)
      }
    }
    const engine = AsrTestService.engine
    AsrTestService.engine = null
    if (engine) {
      try {
        // 不调 cancel：结束前引擎已出 summary/final，cancel 会报 1002200005 尾流噪音
        engine.shutdown()
      } catch (e) {
        Logger.warn('engine shutdown failed: ' + (e as BusinessError).message)
      }
    }
    const summary: Record<string, Object> = {
      'reason': reason,
      'durationMs': AsrTestService.elapsedMs(),
      'partialCount': AsrTestService.partialCount,
      'finalCount': AsrTestService.finalCount,
      'errorCount': AsrTestService.errorCount,
      'firstPartialMs': AsrTestService.firstPartialMs,
      'firstFinalMs': AsrTestService.firstFinalMs,
      'usable': AsrTestService.finalCount > 0
    }
    AsrTestService.emit('summary', summary)
    AsrTestService.status('stopped', 'ASR 测试结束')
  }
}
