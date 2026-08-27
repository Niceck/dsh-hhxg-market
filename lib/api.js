/**
 * dsh-hhxg-market — HTTP 数据层。
 *
 * 两条通道：
 *  - fetchPublic:  免费公开端点（hhxg.top 的 REST API 与静态 JSON），无鉴权。
 *  - mcpCall:      VIP 通道，JSON-RPC 2.0 桥接到 hhxg.top MCP server，
 *                  Bearer mcpToken 鉴权。
 *
 * 全部只读。任何网络/协议错误都归一为带用户可读 message 的 Error，
 * 不向上抛裸响应体；错误信息经 scrub 脱敏，绝不回显 token。
 */

export const BASE_URL = 'https://hhxg.top'
export const MCP_RPC_URL = `${BASE_URL}/mcp/rpc`
export const UPGRADE_URL = `${BASE_URL}/vip.html`
export const TOKEN_URL = `${BASE_URL}/account/mcp.html`

const UA = 'dsh-hhxg-market/0.1'
const TIMEOUT_MS = 20000
const MAX_BODY_BYTES = 5 * 1024 * 1024

// header value 合法字符集（RFC 7230 可见 ASCII）。换行/中文/零宽字符
// 一律拒收——undici 对非法 header 值抛的错误会把整个值回显进 message。
const TOKEN_RE = /^[\x21-\x7E]+$/

/** 错误信息脱敏：token 原文与任何 Bearer 值都不允许出现在错误里。 */
function scrub(msg, secret) {
  let s = String(msg ?? '')
  if (secret && secret.length >= 8) s = s.split(secret).join('«token»')
  return s.replace(/Bearer\s+\S+/gi, 'Bearer «token»')
}

/**
 * 在同一个超时窗口内完成「请求 + 读 body」。
 * 单独包 fetch 不够：header 到达后 clearTimeout 的话，慢速滴数据的
 * body 读取会永久挂起且不再响应用户 abort。
 */
async function withDeadline(signal, run) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), TIMEOUT_MS)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 在 deadline 信号下读 JSON body，带大小上限（防上游投毒灌爆模型上下文）。
 * 流式累计真实字节数，超限即中断读取（不等整包缓冲完才拒绝）。
 */
async function readJson(resp) {
  const len = Number(resp.headers.get('content-length'))
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    throw new Error(`响应过大（${Math.round(len / 1024 / 1024)}MB），已拒绝读取`)
  }
  const reader = resp.body?.getReader()
  if (!reader) return JSON.parse(await resp.text())
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {})
      throw new Error('响应过大，已拒绝解析')
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(bytes)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return JSON.parse(new TextDecoder().decode(buf))
}

function rawFetch(url, init, sig) {
  return fetch(url, {
    ...init,
    signal: sig,
    redirect: 'error',
    headers: { 'User-Agent': UA, ...(init.headers || {}) },
  })
}

/**
 * 免费公开端点。path 例：'/api/snapshot'、'/static/data/assistant/xx.json'。
 * 返回解析后的 JSON；非 2xx 或非 JSON 一律抛用户可读错误。
 */
export async function fetchPublic(path, signal) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('内部错误：非法数据路径')
  }
  return withDeadline(signal, async (sig) => {
    let resp
    try {
      resp = await rawFetch(`${BASE_URL}${path}`, {}, sig)
    } catch (err) {
      throw new Error(`hhxg.top 网络不可用（${scrub(err?.message || err)}），请稍后重试`)
    }
    if (resp.status === 404) throw new Error(`数据不存在 (404): ${path}`)
    if (!resp.ok) throw new Error(`hhxg.top 服务端错误 HTTP ${resp.status}，请稍后重试`)
    try {
      return await readJson(resp)
    } catch (err) {
      // 超时/用户取消不得伪装成站点故障
      if (err?.name === 'AbortError' || sig.aborted) {
        throw new Error('请求已取消或超时，请稍后重试')
      }
      if (/响应过大/.test(String(err?.message))) throw err
      // 残缺部署窗口可能对任意路径吐 HTML 错误页
      throw new Error('数据格式异常，hhxg.top 可能在发布维护，请稍后重试')
    }
  })
}

let rpcSeq = 0

/**
 * VIP 通道：调用 hhxg MCP server 的一个工具，返回其文本结果。
 * MCP 侧 401/403 归一为带解锁指引的错误。
 */
export async function mcpCall(token, toolName, args, signal) {
  const tok = String(token ?? '').trim()
  if (!tok || !TOKEN_RE.test(tok)) {
    throw new Error(
      `MCP Token 格式非法（为空，或含空白/换行/非 ASCII 字符）。` +
      `请到 ${TOKEN_URL} 重新复制完整 Token 并更新插件配置。`,
    )
  }
  return withDeadline(signal, async (sig) => {
    const body = {
      jsonrpc: '2.0',
      id: ++rpcSeq,
      method: 'tools/call',
      params: { name: toolName, arguments: args || {} },
    }
    let resp
    try {
      resp = await rawFetch(MCP_RPC_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, sig)
    } catch (err) {
      throw new Error(`hhxg MCP 网络不可用（${scrub(err?.message || err, tok)}），请稍后重试`)
    }

    let payload = null
    try {
      payload = await readJson(resp)
    } catch (err) {
      if (err?.name === 'AbortError' || sig.aborted) {
        throw new Error('请求已取消或超时，请稍后重试')
      }
      payload = null
    }

    if (resp.status === 401 || resp.status === 403) {
      const code = scrub(payload?.error?.data?.errorCode || `HTTP ${resp.status}`, tok)
      throw new Error(
        `MCP Token 无效或已过期（${code}）。请到 ${TOKEN_URL} 重新生成 Token 并更新插件配置；` +
        `尚未开通 VIP → ${UPGRADE_URL}`,
      )
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error(`hhxg MCP 响应异常（HTTP ${resp.status}），请稍后重试`)
    }
    if (payload.error) {
      const msg = scrub(payload.error.message || 'MCP 调用失败', tok)
      throw new Error(`hhxg MCP: ${msg}`)
    }

    const result = payload.result || {}
    if (result.isError) {
      const text = scrub(extractText(result) || '工具执行失败', tok)
      throw new Error(`hhxg MCP: ${text}`)
    }
    return extractText(result) || JSON.stringify(result, null, 2)
  })
}

/** MCP ToolResult → 纯文本（content 数组里 text 项拼接）。 */
function extractText(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}
