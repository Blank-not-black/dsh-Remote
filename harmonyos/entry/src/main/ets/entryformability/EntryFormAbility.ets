import { formBindingData, FormExtensionAbility, formInfo, formProvider } from '@kit.FormKit';
import { Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { StorageService } from '../services/StorageService';
import { Constants } from '../common/Constants';

const TAG: string = 'EntryFormAbility';
const DOMAIN: number = 0xD00420;

/**
 * 桌面服务卡片生命周期（共包方式，官方 arkts-ui-widget-creation 模式）：
 * - onAddForm：桌面添加卡片 → 回读本地缓存（网关状态/运行会话数/最近会话）立刻填充；
 * - onFormEvent：卡片「刷新」按钮 postCardAction(message) 触发 → 同样回读缓存更新
 *   （FormExtension 进程独立于 UIAbility，不共享 AppState 内存态，读 storage 快照）；
 * - onUpdateForm：定时刷新（updateDuration 30 分钟）到期触发。
 *
 * 卡片进程内不做网络请求：网络轮询由主进程 BackgroundService 负责，
 * 它把最新快照写进 StorageService（KEY_FORM_STATE JSON），卡片只读快照。
 */
export default class EntryFormAbility extends FormExtensionAbility {
  onAddForm(want: Want): formBindingData.FormBindingData {
    hilog.info(DOMAIN, TAG, 'onAddForm');
    return formBindingData.createFormBindingData(EntryFormAbility.snapshot());
  }

  onCastToNormalForm(formId: string): void {
    hilog.info(DOMAIN, TAG, 'onCastToNormalForm');
  }

  onUpdateForm(formId: string): void {
    hilog.info(DOMAIN, TAG, 'onUpdateForm');
    EntryFormAbility.push(formId);
  }

  onFormEvent(formId: string, message: string): void {
    hilog.info(DOMAIN, TAG, 'onFormEvent msg=' + message);
    EntryFormAbility.push(formId);
  }

  onRemoveForm(formId: string): void {
    hilog.info(DOMAIN, TAG, 'onRemoveForm');
  }

  onAcquireFormState(want: Want): formInfo.FormState {
    return formInfo.FormState.READY;
  }

  /** 从主进程写入的存储快照构造卡片绑定数据 */
  private static snapshot(): Record<string, string> {
    const raw = StorageService.getString(Constants.KEY_FORM_STATE, '')
    let title = ''
    let running = ''
    let stateText = ''
    let stateOn = ''
    try {
      const obj = JSON.parse(raw) as Record<string, Object>
      title = String(obj['title'] ?? '')
      running = String(obj['running'] ?? '')
      stateOn = String(obj['ok'] ?? '') === '1' ? '1' : '0'
    } catch (e) {
      // 快照缺失按未配置处理
    }
    if (stateOn === '1') {
      stateText = '已连接'
    } else {
      stateText = '未连接'
    }
    if (running.length === 0) {
      running = '0'
    }
    if (title.length === 0) {
      title = '暂无进行中的会话'
    }
    const data: Record<string, string> = {
      'title': title,
      'running': running,
      'stateText': stateText,
      'stateOn': stateOn
    }
    return data
  }

  /** 用当前快照刷新指定卡片 */
  private static push(formId: string): void {
    const data = formBindingData.createFormBindingData(EntryFormAbility.snapshot());
    formProvider.updateForm(formId, data).catch((error: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'updateForm failed ' + JSON.stringify(error));
    });
  }
}
