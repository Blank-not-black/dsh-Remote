import { preferences } from '@kit.ArkData'
import { common } from '@kit.AbilityKit'
import { Constants } from '../common/Constants'
import { ServerInfo } from '../models/ServerInfo'

/**
 * 本地持久化（preferences）。
 * token 只存 preferences 与请求头，不写入日志、通知或反馈。
 */
export class StorageService {
  private static pref: preferences.Preferences | null = null
  private static appContext: common.UIAbilityContext | null = null

  static init(context: common.UIAbilityContext): void {
    if (StorageService.pref === null) {
      const options: preferences.Options = { name: Constants.STORAGE_NAME }
      StorageService.pref = preferences.getPreferencesSync(context, options)
    }
    StorageService.appContext = context
  }

  /** 应用沙箱文件目录（下载文件落盘用） */
  static getFilesDir(): string {
    const ctx = StorageService.appContext
    if (ctx) {
      return ctx.filesDir
    }
    return ''
  }

  /** AbilityContext（通知授权等需要） */
  static getContext(): common.UIAbilityContext | null {
    return StorageService.appContext
  }

  private static store(): preferences.Preferences {
    return StorageService.pref as preferences.Preferences
  }

  static getString(key: string, def: string): string {
    return StorageService.store().getSync(key, def) as string
  }

  static putString(key: string, value: string): void {
    const pref = StorageService.store()
    pref.putSync(key, value)
    pref.flush()
  }

  static deleteKey(key: string): void {
    const pref = StorageService.store()
    pref.deleteSync(key)
    pref.flush()
  }

  static getServers(): ServerInfo[] {
    const json = StorageService.getString(Constants.KEY_SERVERS, '')
    return ServerInfo.fromJsonArray(json)
  }

  static saveServers(list: ServerInfo[]): void {
    StorageService.putString(Constants.KEY_SERVERS, ServerInfo.toJsonArray(list))
  }

  static getActiveServerId(): string {
    return StorageService.getString(Constants.KEY_ACTIVE_SERVER_ID, '')
  }

  static setActiveServerId(id: string): void {
    StorageService.putString(Constants.KEY_ACTIVE_SERVER_ID, id)
  }

  /** 生成并持久化客户端 id（网关设备识别用，不敏感） */
  static getOrCreateClientId(): string {
    const existing = StorageService.getString(Constants.KEY_CLIENT_ID, '')
    if (existing.length > 0) {
      return existing
    }
    const rand = Date.now().toString(36) +
      Math.random().toString(36).substring(2, 10) +
      Math.random().toString(36).substring(2, 6)
    StorageService.putString(Constants.KEY_CLIENT_ID, rand)
    return rand
  }
}