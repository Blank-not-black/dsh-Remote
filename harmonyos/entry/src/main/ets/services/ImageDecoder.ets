import { image } from '@kit.ImageKit'
import { util } from '@kit.ArkTS'

/**
 * base64 data URL → PixelMap 解码。
 * 消息图片块：data:image/png;base64,XXXX...
 */
export class ImageDecoder {
  static async decode(dataUrl: string): Promise<image.PixelMap> {
    const comma = dataUrl.indexOf(',')
    const base64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl
    const helper = new util.Base64Helper()
    const bytes = helper.decodeSync(base64)
    const source = image.createImageSource(bytes.buffer)
    try {
      const pixelMap = await source.createPixelMap()
      return pixelMap
    } finally {
      try {
        await source.release()
      } catch (e) {
        // 释放失败忽略
      }
    }
  }
}