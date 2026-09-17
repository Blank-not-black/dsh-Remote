import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window, display, mediaquery } from '@kit.ArkUI';
import { IBestInit, IBestSetUIBaseStyle } from '@ibestservices/ibest-ui-v2';
import { AppState } from '../services/AppState';
import { BackgroundService } from '../services/BackgroundService';
import { Constants } from '../common/Constants';
import { Logger } from '../common/Logger';

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

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'testTag', 'Succeeded in loading the content.');
    });

    // IBest-UI 组件库初始化（需要 windowStage 与 context）
    try {
      IBestInit(windowStage, this.context);
      // 全局基样式：组件库主色/圆角对齐鸿蒙设计令牌，
      // 使 IBestSwitch / IBestCell / IBestButton 等与页面自绘部分观感一致。
      IBestSetUIBaseStyle({
        primary: '#0A59F7',
        success: '#1FA53C',
        warning: '#E08A00',
        danger: '#E0403C',
        borderRadiusSm: '8',
        borderRadiusMd: '12',
        borderRadiusLg: '16',
        borderRadiusXl: '20'
      });
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to init IBest-UI. Cause: %{public}s', JSON.stringify(err));
    }
  }

  /**
   * 系统深浅监听：media query '(dark-mode: true)'。
   * 注册即得到初值（matches），变化时回调 on('change')——
   * 两路都写 AppStorage('systemDark') 并同步深浅判定。
   */
  private watchSystemDark(windowStage: window.WindowStage): void {
    const ui = windowStage.getMainWindowSync().getUIContext();
    const listener = ui.getMediaQuery().matchMediaSync('(dark-mode: true)');
    listener.on('change', (result: mediaquery.MediaQueryResult) => {
      this.onSystemDark(result.matches === true);
    });
    this.onSystemDark(listener.matches === true);
  }

  private onSystemDark(systemDark: boolean): void {
    AppStorage.setOrCreate('systemDark', systemDark);
    AppState.instance.onSystemDarkChange(systemDark);
    try {
      window.getLastWindow(this.context).then((win: window.Window) => {
        const dark = AppState.instance.darkMode === Constants.DARK_DARK ||
          (AppState.instance.darkMode === Constants.DARK_SYSTEM && systemDark);
        this.applyBarStyle(win, dark);
      });
    } catch (e) {
      // 忽略
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