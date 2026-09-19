import { fileIo as fs, picker } from '@kit.CoreFileKit'
import { cryptoFramework } from '@kit.CryptoArchitectureKit'
import { http } from '@kit.NetworkKit'
import { GatewayApi } from './GatewayApi'
import { I18n } from '../common/I18n'

export type UploadProgress = (percent: number) => void
export type UploadDone = (ok: boolean, message: string) => void

/** 所选文件统计 */
export interface FileStat {
  name: string
  size: number
}

/** 单分块上传响应 */
export interface ChunkResult {
  status: number
  json: Record<string, Object>
}

/**
 * 分块上传：DocumentViewPicker 选文件 → 全量 SHA-256 → probe 续传
 * → 4MB 分块 POST /fs/upload → finish 块完成落位。
 * probe / upload / control 全程使用同一个 session（网关按 session 命名分片）。
 * 契约见 docs/modules/01-contracts.md 与网关 /fs 区域。
 */
export class FsUploadService {
  static readonly CHUNK_SIZE: number = 4 * 1024 * 1024

  /** 选择单个文件，返回 uri（取消返回空串） */
  static async pickFile(): Promise<string> {
    try {
      const documentPicker = new picker.DocumentViewPicker()
      const result = await documentPicker.select({ maxSelectNumber: 1 })
      if (result && result.length > 0) {
        return result[0]
      }
      return ''
    } catch (e) {
      return ''
    }
  }

  static async statUri(uri: string): Promise<FileStat | null> {
    try {
      const st = fs.statSync(uri)
      const slash = uri.lastIndexOf('/')
      const name = slash >= 0 ? uri.substring(slash + 1) : uri
      const stat: FileStat = { name: name, size: st.size }
      return stat
    } catch (e) {
      return null
    }
  }

  /** 从目录+文件名确定性派生 session（网关白名单字符，截到 64） */
  private static deriveSession(dirPath: string, name: string): string {
    let h = 5381
    const src = dirPath + '\u0000' + name
    for (let i = 0; i < src.length; i++) {
      h = ((h * 33) + (src.charCodeAt(i) & 0xffff)) & 0xffffffff
    }
    const hex = (h >>> 0).toString(16).padStart(8, '0')
    return 'h-' + hex + hex
  }

  static async upload(base: string, token: string, dirPath: string, uri: string,
    onProgress: UploadProgress, onDone: UploadDone): Promise<void> {
    if (uri.length === 0) {
      onDone(false, I18n.t('未选择文件', 'No file selected'))
      return
    }
    const stat = await FsUploadService.statUri(uri)
    if (!stat) {
      onDone(false, I18n.t('无法读取所选文件', 'Cannot read the selected file'))
      return
    }
    const name = stat.name
    const size = stat.size
    let file: fs.File | null = null
    try {
      file = fs.openSync(uri, fs.OpenMode.READ_ONLY)
    } catch (e) {
      onDone(false, I18n.t('打开文件失败：', 'Open file failed: ') + (e as Error).message)
      return
    }
    try {
      onProgress(0)
      // 1) 全量 SHA-256（40% 进度段）
      const sha = await FsUploadService.hashFile(file, size, onProgress)
      // 哈希读完一遍，关闭后重新打开以便从头分块上传
      fs.closeSync(file)
      file = null
      file = fs.openSync(uri, fs.OpenMode.READ_ONLY)
      // 2) 上传 session：probe / upload / control 全程共用同一个值。
      //    网关分片文件按 session 命名（.<name>.dsh-remote-part-<session>），
      //    probe 不带 session 会查 'default'，永远找不到本上传的分片。
      //    session 按目录+文件名确定性派生：App 被杀重开后续传仍能命中
      //    上次分片；同名文件并发上传由网关 upload-busy 挡住，语义安全。
      const session = FsUploadService.deriveSession(dirPath, name)
      // 3) probe：续传偏移
      let offset: number = 0
      const info = await FsUploadService.probe(base, token, dirPath, name, size, session)
      if (info && info['ok'] === true) {
        offset = Number(info['partialSize'] ?? 0)
      }
      if (offset < 0) {
        offset = 0
      }
      // 4) 分块上传（40% → 100%）
      const basePercent = 40
      const span = 60
      while (offset < size) {
        const chunkLen = Math.min(FsUploadService.CHUNK_SIZE, size - offset)
        const chunk = new ArrayBuffer(chunkLen)
        // ReadOptions.offset 是"期望读取文件的位置"（官方 fs 文档语义）：
        // 不传才从当前位置续读。必须显式传当前上传 offset，
        // 否则每轮都重读文件首块，>4MiB 的文件会被写成 A+A+…。
        const read = fs.readSync(file.fd, chunk, { offset: offset, length: chunkLen })
        if (read <= 0) {
          onDone(false, I18n.t('读取文件失败', 'Read file failed'))
          return
        }
        const isLast = (offset + read) >= size
        const chunkBytes = new ArrayBuffer(read)
        new Uint8Array(chunkBytes).set(new Uint8Array(chunk, 0, read))
        const r = await FsUploadService.uploadChunk(base, token, dirPath, name, session,
          offset, size, chunkBytes, isLast ? sha : '')
        if (r.status === 200 && r.json['offset'] !== undefined) {
          offset = Number(r.json['offset'])
          onProgress(Math.round(basePercent + (offset / Math.max(1, size)) * span))
          continue
        }
        if (r.status === 201) {
          if (r.json['sha256'] && String(r.json['sha256']) !== sha) {
            onDone(false, I18n.t('校验和不匹配，上传未完成', 'Checksum mismatch; upload incomplete'))
          } else {
            onProgress(100)
            onDone(true, name)
          }
          return
        }
        if (r.status === 409 && String(r.json['error']) === 'offset-mismatch') {
          const again = await FsUploadService.probe(base, token, dirPath, name, size, session)
          if (again && again['ok'] === true) {
            offset = Number(again['partialSize'] ?? 0)
            continue
          }
          offset = 0
          continue
        }
        if (r.status === 422 && String(r.json['error']) === 'checksum-mismatch') {
          await FsUploadService.cancelPartial(base, token, dirPath, name, session)
          onDone(false, I18n.t('坏分片已清理，请重试', 'Bad chunk cleaned; please retry'))
        } else if (r.status === 409 && String(r.json['error']) === 'conflict') {
          // v0.6.26 网关语义：目标文件已存在且未带 overwrite（201 提交走 link 排他创建）
          onDone(false, I18n.t('文件已存在，未覆盖', 'File already exists; not overwritten'))
        } else if (r.status === 409 && String(r.json['error']) === 'upload-busy') {
          // 同目录同名上传进行中（网关按 Windows 大小写不敏感键判重）
          onDone(false, I18n.t('该文件正在上传中，请稍后重试', 'An upload for this file is already in progress'))
        } else {
          onDone(false, I18n.t('上传失败：', 'Upload failed: ') + String(r.json['error'] ?? 'HTTP ' + r.status.toString()))
        }
        return
      }
      // offset 已到末尾（0 字节文件 / 收尾中断）：空 finish 块
      if (offset >= size) {
        const r = await FsUploadService.uploadChunk(base, token, dirPath, name, session,
          offset, size, new ArrayBuffer(0), sha)
        if (r.status === 201) {
          onProgress(100)
          onDone(true, name)
        } else if (r.status === 409 && String(r.json['error']) === 'conflict') {
          onDone(false, I18n.t('文件已存在，未覆盖', 'File already exists; not overwritten'))
        } else {
          onDone(false, I18n.t('收尾失败：', 'Finish failed: ') + String(r.json['error'] ?? 'HTTP ' + r.status.toString()))
        }
      }
    } catch (e) {
      onDone(false, I18n.t('上传异常：', 'Upload error: ') + (e as Error).message)
    } finally {
      if (file) {
        try {
          fs.closeSync(file)
        } catch (e) {
          // 忽略关闭错误
        }
      }
    }
  }

  private static async hashFile(file: fs.File, size: number, onProgress: UploadProgress): Promise<string> {
    const md = cryptoFramework.createMd('SHA256')
    let total: number = 0
    const buf = new ArrayBuffer(FsUploadService.CHUNK_SIZE)
    try {
      while (total < size) {
        const chunkLen = Math.min(FsUploadService.CHUNK_SIZE, size - total)
        // 与上传读取同样的坑：必须传累计 total 作为读取位置，否则哈希只算首块
        const read = fs.readSync(file.fd, buf, { offset: total, length: chunkLen })
        if (read <= 0) {
          break
        }
        md.updateSync({ data: new Uint8Array(buf, 0, read) })
        total += read
        onProgress(Math.round(total / Math.max(1, size) * 40))
      }
      const digest = await md.digest()
      const bytes = digest.data
      let hex: string = ''
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]
        hex += (b < 16 ? '0' : '') + b.toString(16)
      }
      return hex
    } finally {
      // Md 生命周期由运行时管理，无需手动销毁
    }
  }

  private static async uploadChunk(base: string, token: string, dirPath: string, name: string,
    session: string, offset: number, size: number, chunk: ArrayBuffer, sha: string): Promise<ChunkResult> {
    const req = http.createHttp()
    try {
      const params: string[] = []
      params.push('path=' + encodeURIComponent(dirPath))
      params.push('name=' + encodeURIComponent(name))
      params.push('session=' + encodeURIComponent(session))
      params.push('offset=' + offset.toString())
      params.push('size=' + size.toString())
      if (sha.length > 0) {
        params.push('finish=1')
        params.push('sha256=' + sha)
      }
      const url = base.replace(/\/+$/, '') + '/fs/upload?' + params.join('&')
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: {
          'content-type': 'application/octet-stream',
          'authorization': 'Bearer ' + token,
          'x-dsh-remote-client': 'app'
        },
        extraData: chunk,
        connectTimeout: 8000,
        readTimeout: 60000,
        expectDataType: http.HttpDataType.STRING
      }
      const resp = await req.request(url, options)
      let json: Record<string, Object> = {}
      try {
        json = JSON.parse(resp.result as string) as Record<string, Object>
      } catch (e) {
        // 非 JSON 错误体
      }
      const result: ChunkResult = { status: resp.responseCode, json: json }
      return result
    } finally {
      req.destroy()
    }
  }

  private static async probe(base: string, token: string, dirPath: string, name: string,
    size: number, session: string): Promise<Record<string, Object> | null> {    try {
      const path = `/fs/upload-probe?path=${encodeURIComponent(dirPath)}` +
        `&name=${encodeURIComponent(name)}&size=${size.toString()}` +
        `&session=${encodeURIComponent(session)}`
      return await GatewayApi.getJson(base, path, token, 15000)
    } catch (e) {
      return null
    }
  }

  private static async cancelPartial(base: string, token: string, dirPath: string, name: string,
    session: string): Promise<void> {
    const req = http.createHttp()
    try {
      const url = base.replace(/\/+$/, '') + '/fs/upload-control?path=' + encodeURIComponent(dirPath) +
        '&name=' + encodeURIComponent(name) + '&session=' + encodeURIComponent(session) + '&action=cancel'
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: {
          'authorization': 'Bearer ' + token,
          'x-dsh-remote-client': 'app'
        },
        connectTimeout: 8000,
        readTimeout: 15000
      }
      await req.request(url, options)
    } catch (e) {
      // 清理失败忽略
    } finally {
      req.destroy()
    }
  }
}