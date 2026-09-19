import { picker, fileIo as fs } from '@kit.CoreFileKit'
import { util } from '@kit.ArkTS'
import { BusinessError } from '@kit.BasicServicesKit'
import { Logger } from '../common/Logger'

/**
 * 文件导出：把内容写到用户在系统「另存为」里选择的位置。
 *
 * 对应 Android 端 UpdateBridge.downloadToDownloads（DownloadManager 落系统 Downloads）
 * 的能力等价物：HarmonyOS 没有可编程的系统下载目录，正统方案是
 * DocumentViewPicker save 模式——系统弹出另存为，用户挑目录与文件名，
 * 返回的 uri 自带读写授权，应用无需存储权限即可落盘。
 *
 * 文档出处：
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/select-user-file
 */
export class FileExporter {
  /** 保存二进制内容；返回目标 uri，用户取消/失败返回 '' */
  static async saveBytes(data: ArrayBuffer, fileName: string): Promise<string> {
    const uri = await FileExporter.pickTarget(fileName)
    if (uri.length === 0) {
      return ''
    }
    const file = fs.openSync(uri, fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC)
    try {
      fs.writeSync(file.fd, data)
    } finally {
      fs.closeSync(file)
    }
    return uri
  }

  /** 保存文本内容（UTF-8）；返回目标 uri，用户取消/失败返回 '' */
  static async saveText(text: string, fileName: string): Promise<string> {
    return await FileExporter.saveBytes(FileExporter.utf8(text), fileName)
  }

  private static utf8(text: string): ArrayBuffer {
    const helper = new util.TextEncoder()
    return helper.encodeInto(text).buffer as ArrayBuffer
  }

  /** 弹系统另存为；用户取消返回 '' */
  private static async pickTarget(fileName: string): Promise<string> {
    try {
      const doc = new picker.DocumentViewPicker()
      const opts = new picker.DocumentSaveOptions()
      opts.newFileNames = [fileName]
      const uris = await doc.save(opts)
      if (uris && uris.length > 0) {
        return uris[0]
      }
      return ''
    } catch (e) {
      Logger.warn('save picker failed: ' + (e as BusinessError).message)
      return ''
    }
  }

  /** 取目标 uri 的纯文件名（toast 展示用） */
  static baseName(uri: string): string {
    const slash = uri.lastIndexOf('/')
    return slash >= 0 ? uri.substring(slash + 1) : uri
  }
}
