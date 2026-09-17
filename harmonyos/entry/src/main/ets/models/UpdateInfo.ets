/**
 * 更新信息（update.json 子集）。
 * hapUrl 为本端预留字段：将来发布鸿蒙 HAP 时填入直链。
 */
export class UpdateInfo {
  version: string
  notes: string
  apkUrl: string
  hapUrl: string
  releasedAt: string

  constructor(version: string, notes: string, apkUrl: string, hapUrl: string, releasedAt: string) {
    this.version = version
    this.notes = notes
    this.apkUrl = apkUrl
    this.hapUrl = hapUrl
    this.releasedAt = releasedAt
  }

  static fromRecord(r: Record<string, Object>): UpdateInfo {
    return new UpdateInfo(
      String(r['version'] ?? ''),
      String(r['notes'] ?? ''),
      String(r['apkUrl'] ?? ''),
      String(r['hapUrl'] ?? ''),
      String(r['releasedAt'] ?? '')
    )
  }
}