import { hilog } from '@kit.PerformanceAnalysisKit'
import { Constants } from './Constants'

/**
 * 统一日志封装，便于后续统一脱敏或调整级别。
 * 注意：不得把 token、API key、会话内容写入日志。
 */
export class Logger {
  static info(msg: string): void {
    hilog.info(Constants.LOG_DOMAIN, Constants.LOG_TAG, '%{public}s', msg)
  }

  static warn(msg: string): void {
    hilog.warn(Constants.LOG_DOMAIN, Constants.LOG_TAG, '%{public}s', msg)
  }

  static error(msg: string): void {
    hilog.error(Constants.LOG_DOMAIN, Constants.LOG_TAG, '%{public}s', msg)
  }
}