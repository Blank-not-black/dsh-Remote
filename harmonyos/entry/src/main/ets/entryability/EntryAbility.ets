import { AbilityConstant, UIAbility, Want, ConfigurationConstant, Configuration } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window, display } from '@kit.ArkUI';
import { AppState } from '../services/AppState';
import { BackgroundService } from '../services/BackgroundService';
import { Constants } from '../common/Constants';
import { Logger } from '../common/Logger';
import { Breakpoint } from '../common/Breakpoint';
import { SystemDarkWatch } from '../common/SystemDarkWatch';

const DOMAIN = Constants.LOG_DOMAIN;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onCreate');
    // 初始化全局状态：持久化、服务器列表、实时链路
    AppStorage.setOrCreate('appState', AppState.instance);
    AppState.instance.init(this.context);
    this.handlePairWant(want);
  }

  /** 应用已在前台时再次收到深链 */
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.handlePairWant(want);
  }

  /**
   * dshremote://pair?token=..&server=.. 深链配对。
   * 与扫码配对走同一条导入路径（AppState.applyPairUri）。
   */
  private handlePairWant(want: Want): void {
    const uri = want && want.uri ? want.uri : '';
    if (uri.length === 0) {
      return;
    }
    const ok = AppState.instance.applyPairUri(uri);
    Logger.info('pair want uri handled=' + (ok ? '1' : '0'));
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onDestroy');
  }

  /**
   * 系统环境变化（深浅切换等）——运行期深浅切换的**正路通知**。
   *
   * 真机踩坑：媒体查询 '(dark-mode: true)' 的 change 事件在运行期收不到
   * （EntryAbility 早期注册只回初值，Index 用页面 UIContext 重注册后同样
   * 收不到 change，控制中心切深色 App 不跟随；首帧初值链路正常）。因此
   * 运行期切换改走 AbilityKit 的 onConfigurationUpdate：系统深浅切换必
   * 派发，config.colorMode 为最新系统色模式（NOT_SET/-1 表示未变化，忽略）。
   * 媒体查询仍保留：负责 loadContent 前的首帧初值。
   */
  onConfigurationUpdate(newConfig: Configuration): void {
    if (newConfig && newConfig.colorMode !== undefined) {
      Logger.info('onConfigurationUpdate colorMode=' + newConfig.colorMode);
      if (newConfig.colorMode !== ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET) {
        SystemDarkWatch.apply(newConfig.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK)
      }
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // Main window is created, set main page for this ability
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageCreate');

    // 沉浸式全屏：窗口延伸到状态栏与手势指示条之下，安全区由页面自行避让。
    // 必须在 loadContent 之前同步完成，保证首帧渲染时就能读到正确安全区。
    try {
      const win = windowStage.getMainWindowSync();
      win.setWindowLayoutFullScreen(true);
      // 状态栏内容色与窗口底色随深浅模式：跟随系统时先按 systemDark 快照判定
      this.applyBarStyle(win, AppState.instance.darkMode === Constants.DARK_DARK ||
        (AppState.instance.darkMode === Constants.DARK_SYSTEM &&
          AppStorage.get<boolean>('systemDark') === true));
      const d = display.getDefaultDisplaySync();
      const density = d.densityPixels > 0 ? d.densityPixels : 3.5;
      const sysTop = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).topRect.height;
      const navBottom = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR).bottomRect.height;
      AppStorage.setOrCreate('safeTopVp', Math.ceil(sysTop / density));
      AppStorage.setOrCreate('safeBottomVp', Math.ceil(navBottom / density));
    } catch (err) {
      // 全屏失败时保持系统默认避让布局，页面读到的安全区为 0，样式仍然自洽
      hilog.error(DOMAIN, 'testTag', 'Failed to setup immersive window. Cause: %{public}s', JSON.stringify(err));
    }

    // 系统深浅监听必须在 loadContent 之前注册：注册即同步初值，
    // 保证首帧渲染时 AppState 已把正确的 uiDark 落入 AppStorage
    try {
      this.watchSystemDark(windowStage);
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to watch colorMode. Cause: %{public}s', JSON.stringify(err));
    }

    // 宽屏断点监听（≥600vp）：同样首帧前同步初值，决定 Index 渲染
    // 手机 Tabs 布局还是平板 Navigation 分栏布局
    try {
      Breakpoint.watch(windowStage.getMainWindowSync().getUIContext());
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to watch breakpoint. Cause: %{public}s', JSON.stringify(err));
    }

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'testTag', 'Succeeded in loading the content.');
      // 应用级 colorMode 跟随 App 内深浅设置（默认 system）：不设时未显式
      // 指定 fontColor 的文字/输入框走系统资源色——系统深色 + App 浅色主题
      // 时会出现白底白字（官方建议 loadContent 完成后调用，见
      // bpta-dark-mode-adaptation 与 ApplicationContext.setColorMode 文档）。
      this.applyAppColorMode();
    });
  }

  /**
   * 系统深浅监听（首帧初值）：媒体查询 '(dark-mode: true)' 注册即同步初值，
   * 保证 loadContent 前 AppState 已把正确的 uiDark 落入 AppStorage。
   * 运行期 change 事件由 Index.aboutToAppear 用页面 UIContext 重注册接管
   * （loadContent 前 UIContext 上的监听收不到后续事件，见 SystemDarkWatch）。
   */
  private watchSystemDark(windowStage: window.WindowStage): void {
    const ui = windowStage.getMainWindowSync().getUIContext();
    SystemDarkWatch.watch(ui);
  }

  /**
   * 应用级 colorMode 同步 App 内深浅设置（AppState.darkMode: system/light/dark）。
   * system → COLOR_MODE_NOT_SET（跟随系统资源）；light/dark → 显式锁定。
   * 供 loadContent 完成后初始化调用；运行期切换由 Index.onUiDarkChange 走
   * common/AppColorMode 同一逻辑。
   */
  private applyAppColorMode(): void {
    try {
      const mode = AppState.instance.darkMode;
      const appContext = this.context.getApplicationContext();
      if (mode === Constants.DARK_LIGHT) {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
      } else if (mode === Constants.DARK_DARK) {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
      } else {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
      }
    } catch (e) {
      hilog.error(DOMAIN, 'testTag', 'applyAppColorMode failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 状态栏内容色 + 窗口背景随深浅（窗口底色仅影响根窗口，失败可忽略） */
  private applyBarStyle(win: window.Window, dark: boolean): void {
    try {
      win.setWindowSystemBarProperties({ statusBarContentColor: dark ? '#F2F3F5' : '#1F2937' });
    } catch (e) {
      // 忽略
    }
    try {
      win.setWindowBackgroundColor(dark ? '#121214' : '#F1F3F5');
    } catch (e) {
      // 部分设备不支持时忽略
    }
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onForeground');
    BackgroundService.stop();
  }

  onBackground(): void {
    // Ability has back to background
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onBackground');
    if (AppState.instance.notifyEnabled && AppState.instance.backgroundPoll) {
      // 长时任务需要 UIAbilityContext；申请失败时内部降级为普通定时器
      BackgroundService.start(this.context);
    } else {
      BackgroundService.stop();
    }
  }
}