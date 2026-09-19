/**
 * 轻量 UI 反馈辅助：Toast 统一封装。
 *
 * 此前 FilesPage / SettingsPage 各写一份 private toast()（实现相同、
 * duration 不一致：3000/3500），抽到一处避免漂移。
 */
export class UiFeedback {
  /** Toast 提示（getPromptAction 要求 UI 上下文；由调用方传入自身组件的） */
  static toast(ctx: UIContext, msg: string, durationMs: number = 3000): void {
    try {
      ctx.getPromptAction().showToast({ message: msg, duration: durationMs })
    } catch (e) {
      // 个别场景（页面即将销毁等）取不到 promptAction，静默
    }
  }
}
