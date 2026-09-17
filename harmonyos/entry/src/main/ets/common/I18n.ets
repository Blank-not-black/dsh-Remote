import { i18n } from '@kit.LocalizationKit'

/**
 * 双语支持：语言来源 = 系统语言，无应用内切换（2026-09-16 用户决策）。
 *
 * 用法：I18n.t('中文文案', 'English text') 就地给双语——两个文案相邻可见，
 * 不需要 key 管理与字典文件（与 WebUI i18n.js 的 zh/en 结构同源，但省掉 key 间接层）。
 * 系统语言在启动时读一次（AppState.init），变更下次启动生效。
 *
 * 语种判定与 Web 端一致：zh 开头 → 中文，其余英文。
 * https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-i18n
 */
export class I18n {
  private static lang: string = 'zh'

  /** AppState.init 调用：读系统语言，仅启动时执行一次 */
  static init(): void {
    try {
      const sys: string = i18n.System.getSystemLanguage()
      I18n.lang = sys.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    } catch (e) {
      // 读取失败按中文兜底（主用户群语言）
      I18n.lang = 'zh'
    }
  }

  static isZh(): boolean {
    return I18n.lang === 'zh'
  }

  /** 就地双语：zh 系统 → 前者，否则 → 后者 */
  static t(zh: string, en: string): string {
    return I18n.lang === 'zh' ? zh : en
  }
}
