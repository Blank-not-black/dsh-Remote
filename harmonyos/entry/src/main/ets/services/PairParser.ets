/**
 * 配对二维码解析：dshremote://pair?token=<token>&server=<url1>&server=<url2>...
 */
export interface PairPayload {
  token: string
  servers: string[]
}

export class PairParser {
  static parsePairUrl(raw: string): PairPayload | null {
    if (!raw.startsWith('dshremote://pair')) {
      return null
    }
    const qIdx = raw.indexOf('?')
    if (qIdx < 0) {
      return null
    }
    const query = raw.substring(qIdx + 1)
    const nameToValues: Map<string, string[]> = new Map()
    const parts = query.split('&')
    for (const part of parts) {
      if (part.length === 0) {
        continue
      }
      const eq = part.indexOf('=')
      const key = eq >= 0 ? part.substring(0, eq) : part
      const value = eq >= 0 ? part.substring(eq + 1) : ''
      let decoded: string = ''
      try {
        decoded = decodeURIComponent(value)
      } catch (e) {
        decoded = value
      }
      if (!nameToValues.has(key)) {
        nameToValues.set(key, [])
      }
      const list = nameToValues.get(key) as string[]
      list.push(decoded)
    }
    const tokens = nameToValues.has('token') ? (nameToValues.get('token') as string[]) : []
    const token = tokens.length > 0 ? tokens[0] : ''
    const servers: string[] = []
    const rawServers = nameToValues.has('server') ? (nameToValues.get('server') as string[]) : []
    for (const s of rawServers) {
      if (s.length > 0 && servers.indexOf(s) < 0) {
        servers.push(s)
      }
    }
    if (token.length === 0 || servers.length === 0) {
      return null
    }
    const payload: PairPayload = { token: token, servers: servers }
    return payload
  }
}