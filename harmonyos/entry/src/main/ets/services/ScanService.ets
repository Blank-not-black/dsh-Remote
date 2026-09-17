import { scanBarcode, scanCore } from '@kit.ScanKit'
import { common } from '@kit.AbilityKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { Logger } from '../common/Logger'

/**
 * 扫码：调起系统 Scan Kit 默认扫码界面，返回识别文本。
 */
export class ScanService {
  static async scanText(context: common.Context): Promise<string> {
    try {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.ALL],
        enableAlbum: true
      }
      const result = await scanBarcode.startScanForResult(context, options)
      const value = String(result.originalValue ?? '')
      return value
    } catch (e) {
      Logger.warn('scan failed: ' + (e as BusinessError).message)
      return ''
    }
  }
}