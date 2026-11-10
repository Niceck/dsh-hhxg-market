/**
 * dsh-hhxg-market — 数据层：全部经 hhxg.top MCP server（JSON-RPC 2.0，Bearer mcpToken 鉴权）。
 *
 * 两个方法：
 *  - mcpCall:         tools/call —— 调用服务端一个正式工具，返回其文本结果。
 *  - mcpReadResource: resources/read —— 按 URI 读一份只读资源（KB 信封 / 日历 / 数据集索引），返回解析后的 JSON。
 *
 * 全部只读。任何网络/协议错误都归一为带用户可读 message 的 Error，
 * 不向上抛裸响应体；错误信息经 scrub 脱敏，绝不回显 token。
 */

import { createRequire } from 'node:module'

export const BASE_URL = 'https://hhxg.top'
export const MCP_RPC_URL = `${BASE_URL}/mcp/rpc`
export const UPGRADE_URL = `${BASE_URL}/vip.html`
/** AI 接入 Token（即 MCP Token）签发页：2026-10-22 起在「AI 接入」页 developer.html（旧地址 /account/mcp.html 只剩一个跳转壳）。 */
export const TOKEN_URL = `${BASE_URL}/developer.html#mcp`
/** mcpToken 的环境变量回退来源（终端启动 dsh 时可用；GUI 启动不一定继承 shell 环境）。 */
export const TOKEN_ENV = 'HHXG_MCP_TOKEN'
/** 本插件读取的资源 URI 前缀（服务端 agent_tools/resources.js 的 SCHEME）。 */
export const RESOURCE_SCHEME = 'hhxg://'

/**
 * 解析 MCP Token 来源：显式配置（非空）优先；为空才看环境变量 HHXG_MCP_TOKEN；两者都空 = 未配置。
 * 显式配置非法（含空白 / 非 ASCII）时不回退环境变量——那是用户填错了，要报错而不是悄悄换一把。
 * 返回 { token, source }，source ∈ config / env / none；只在 host apply() 读一次，不写回任何地方。
 */
export function resolveMcpToken(config, env = process.env) {
  const configured = typeof config?.mcpToken === 'string' ? config.mcpToken.trim() : ''
  if (configured) return { token: configured, source: 'config' }
  const fromEnv = typeof env?.[TOKEN_ENV] === 'string' ? env[TOKEN_ENV].trim() : ''
  if (fromEnv) return { token: fromEnv, source: 'env' }
  return { token: '', source: 'none' }
}

const require = createRequire(import.meta.url)
const { version: PLUGIN_VERSION } = require('../package.json')
const UA = `dsh-hhxg-market/${PLUGIN_VERSION}`
const TIMEOUT_MS = 20000
const MAX_BODY_BYTES = 5 * 1024 * 1024

// header value 合法字符集（RFC 7230 可见 ASCII）。换行/中文/零宽字符
// 一律拒收——undici 对非法 header 值抛的错误会把整个值回显进 message。
const TOKEN_RE = /^[\x21-\x7E]+$/

// 瞬时故障重试：总尝试次数与退避间隔
const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 800

/** 标记「值得重试」的失败（5xx / 网络抖动 / 部署中途的坏响应）。 */
class RetryableError extends Error {}

/** 可被 signal 中断的等待。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('已取消'))
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('已取消'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

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

/** 入口统一校验 token 形状（空 / 空白 / 非 ASCII 一律拒绝，不发请求）。 */
function normalizeToken(token) {
  const tok = String(token ?? '').trim()
  if (!tok || !TOKEN_RE.test(tok)) {
    throw new Error(
      `AI 接入 Token 格式非法（为空，或含空白/换行/非 ASCII 字符）。` +
      `请到 ${TOKEN_URL} 重新复制完整 Token 并更新插件配置。`,
    )
  }
  return tok
}

/**
 * 服务端表示「会员档位不够」的错误码：新码 MAX_REQUIRED，与旧的 API_ACCESS_REQUIRED（MCP / 数据 API 接口权益）、
 * VIP_REQUIRED、REALTIME_MAX_REQUIRED。MCP Token 只签给 Max，持有效 Token 正常遇不到；
 * 真遇到（后台改档 / 会员降级）统一给「需要 Max 的 MCP Token」指引，而不是说 Token 坏了。
 */
const MAX_REQUIRED_CODES = new Set(['MAX_REQUIRED', 'API_ACCESS_REQUIRED', 'VIP_REQUIRED', 'REALTIME_MAX_REQUIRED'])

/** 鉴权 / 权益类失败 → 带解锁指引的 Error（code 已脱敏）。 */
function accessError(code) {
  if (MAX_REQUIRED_CODES.has(code)) {
    return new Error(
      `需要 Max 会员的 AI 接入 Token（${code}）：当前 Token 对应的会员不是 Max，AI 接入 Token（即 MCP Token）只签给 Max。` +
      `升级 → ${UPGRADE_URL}；升级后到 ${TOKEN_URL} 重新生成 Token 并更新插件配置`,
    )
  }
  return new Error(
    `AI 接入 Token 无效或已过期（${code}）。请到 ${TOKEN_URL} 重新生成 AI 接入 Token（即 MCP Token）并更新插件配置；` +
    `尚未开通 Max → ${UPGRADE_URL}`,
  )
}

let rpcSeq = 0

/**
 * 一次 JSON-RPC 请求（含重试）：返回 payload.result。
 * 边缘函数实例冷启动时约 2–3% 的首请求会被平台以 545 击杀，隔几百毫秒重试即好。
 * 全部工具都是只读查询，重试无副作用；只对 5xx / 网络抖动重试一次，401 / 4xx / 业务错误不重试。
 */
async function mcpRequest(tok, method, params, signal) {
  let lastErr = null
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS, signal)
    try {
      return await mcpAttempt(tok, method, params, signal)
    } catch (err) {
      if (!(err instanceof RetryableError)) throw err
      lastErr = err
    }
  }
  throw new Error(lastErr?.message || 'hhxg MCP 暂时不可用，请稍后重试')
}

/** 单次尝试；5xx 抛 RetryableError 交给外层决定是否重试。 */
function mcpAttempt(tok, method, params, signal) {
  return withDeadline(signal, async (sig) => {
    const body = { jsonrpc: '2.0', id: ++rpcSeq, method, params }
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
      throw accessError(scrub(payload?.error?.data?.errorCode || `HTTP ${resp.status}`, tok))
    }
    if (!resp.ok) {
      const detail = scrub(payload?.error?.message || '', tok)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
      const message =
        `hhxg MCP 请求失败 HTTP ${resp.status}` +
        (detail ? `（${detail}）` : '') +
        '，请稍后重试'
      throw resp.status >= 500 ? new RetryableError(message) : new Error(message)
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error(`hhxg MCP 响应异常（HTTP ${resp.status}），请稍后重试`)
    }
    if (payload.error) {
      // JSON-RPC 错误层也可能带权益码（会话入口的 Max 预检用 -32602 + data.errorCode）
      const code = payload.error.data?.errorCode
      if (typeof code === 'string' && MAX_REQUIRED_CODES.has(code)) throw accessError(code)
      const msg = scrub(payload.error.message || 'MCP 调用失败', tok)
      throw new Error(`hhxg MCP: ${msg}`)
    }
    return payload.result || {}
  })
}

/**
 * tools/call：调用 hhxg MCP server 的一个正式工具，返回其文本结果。
 * 业务性 isError（无数据 / 参数有误 / 需要 Max 等）转成可读文本正常返回，只有真故障才抛。
 */
export async function mcpCall(token, toolName, args, signal) {
  const tok = normalizeToken(token)
  const result = await mcpRequest(tok, 'tools/call', { name: toolName, arguments: args || {} }, signal)
  if (result.isError) {
    const raw = extractText(result) || '工具执行失败'
    // hhxg MCP 用同一个 isError 表达「真故障」与「业务性无数据」。
    // 后者（票没涨停 / dataset_id 不存在）是正常答案，抛错会让模型
    // 误判成工具坏了——转成可读文本正常返回，只有真故障才抛。
    const biz = parseBusinessError(raw)
    if (biz) return scrub(biz, tok)
    throw new Error(`hhxg MCP: ${scrub(raw, tok)}`)
  }
  return extractText(result) || JSON.stringify(result, null, 2)
}

/** 资源层 isError 里表示「不存在」的说明（服务端 resources.js 的 notFound 文案）：是正常答案，不是故障。 */
const RESOURCE_MISSING_RE = /不存在|未找到/

/**
 * resources/read：读一份 hhxg:// 资源，返回 contents[0].text 解析后的 JSON（KB scope 为 KB v2 信封；
 * 日历 / 数据集索引为服务端拼装的 payload）。
 * 资源不存在（如该月没有事件日历）与 mcpCall 的业务答复同样处理：返回「无结果：…」文本；
 * 非法 URI / 读取失败才抛。
 */
export async function mcpReadResource(token, uri, signal) {
  if (typeof uri !== 'string' || !uri.startsWith(RESOURCE_SCHEME)) {
    throw new Error('内部错误：非法资源 URI')
  }
  const tok = normalizeToken(token)
  const result = await mcpRequest(tok, 'resources/read', { uri }, signal)
  const text = resourceText(result)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`hhxg MCP 资源响应格式异常（${uri}），请稍后重试`)
  }
  if (result.isError) {
    const msg = scrub(String(payload?.error || '资源读取失败'), tok).replace(/\s+/g, ' ').trim().slice(0, 200)
    if (RESOURCE_MISSING_RE.test(msg)) return `无结果：${msg}`
    throw new Error(`hhxg MCP: ${msg}`)
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`hhxg MCP 资源响应异常（${uri}），请稍后重试`)
  }
  return payload
}

/**
 * 业务性 errorCode 白名单（code → 给模型看的前缀）——这些不是故障，是有效答案：没有数据，
 * 或者这次调用的参数 / 取法服务端不接受并说明了该怎么改。渲染成可读文本交给模型，让它据此
 * 调整，而不是当成工具坏了。
 * 盘中实时（get_realtime）另有「暂未就绪」一类：指标帧正在计算 / 没跟上行情、名称表暂不可用——
 * 数据状态，模型可稍后重试或改为只取行情。
 * 「需要 Max」：MAX_REQUIRED / REALTIME_MAX_REQUIRED——持有效 Token 正常遇不到（Token 只签给 Max），
 * 真出现按正常答案附升级地址交给模型转告用户。
 * 其余仍按异常抛出：
 *  - 故障与限流（SERVER_ERROR / RATE_LIMIT_EXCEEDED / TIMEOUT / FETCH_FAILED 等），
 *    含 PRESET_UNAVAILABLE 与 RT_UNAVAILABLE——那是站点查询服务 / 实时采集离线、要稍后重试，不能说成「无结果」；
 *  - 权限类（VIP_REQUIRED / TIER_INSUFFICIENT）——持有效 MCP Token 时服务端不会返回它们，
 *    真出现说明会员权益或服务端有问题。
 */
const BUSINESS_CODES = new Map([
  ['无结果', ['NO_DATA', 'NOT_FOUND', 'UNSUPPORTED_ASSET', 'UNSUPPORTED_FORMAT']],
  // INVALID_ARGUMENT 服务端目前不返回，留作兼容；RESULT_TOO_LARGE = 实时查询结果超限，要减少 codes / fields / limit
  ['参数有误', ['INVALID_ARGUMENT', 'INVALID_ARG', 'INVALID_ARGS', 'UNKNOWN_FIELD', 'UNSUPPORTED_FILTER', 'RESULT_TOO_LARGE']],
  // 该换一种取法：这个策略不能作为预设、数据文件过大、筛选快照只能走全市场筛选
  ['暂不支持', ['PRESET_NOT_SUPPORTED', 'DATASET_TOO_LARGE', 'USE_SCREEN_STOCKS']],
  ['暂未就绪', ['RT_SYNCING', 'RT_INDICATORS_STALE', 'RT_INDICATORS_UNAVAILABLE', 'RT_NAMES_UNAVAILABLE']],
  ['需要 Max', ['MAX_REQUIRED', 'REALTIME_MAX_REQUIRED']],
].flatMap(([label, codes]) => codes.map((code) => [code, label])))

/**
 * 服务端在 meta.url 里给的下载地址（如数据文件过大时）：只认本站 https 地址，且只含 URL 安全字符
 * ——地址会原样进模型上下文，空白、括号、站外域名一律不带。
 */
const SITE_URL_RE = /^https:\/\/hhxg\.top\/[A-Za-z0-9._~%/-]{1,300}$/

/**
 * 上游错误文本若为业务性 JSON 信封，返回给模型看的可读说明；
 * 否则返回 null（交由调用方抛错）。
 */
function parseBusinessError(raw) {
  let obj = null
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const code = String(obj.errorCode || '')
  const label = BUSINESS_CODES.get(code)
  if (!label) return null
  // 说明文字压成单行并截断：多行文本进模型上下文能伪造结构
  const msg = String(obj.error || '无数据').replace(/\s+/g, ' ').trim().slice(0, 300)
  const meta = obj.meta && typeof obj.meta === 'object' ? obj.meta : {}
  const siteUrl = (v) => typeof v === 'string' && SITE_URL_RE.test(v)
  const retry = meta.retry_after_seconds
  const extras = [
    siteUrl(meta.url) ? `下载地址：${meta.url}` : '',
    siteUrl(meta.upgrade_url) ? `升级地址：${meta.upgrade_url}` : '',
    Number.isInteger(retry) && retry >= 1 && retry <= 120 ? `约 ${retry} 秒后可重试` : '',
  ].filter(Boolean)
  return `${label}：${msg}（${code}）${extras.map((x) => `\n${x}`).join('')}`
}

/** MCP ToolResult → 纯文本（content 数组里 text 项拼接）。 */
function extractText(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

/** MCP ReadResourceResult → 第一份文本内容（contents[0].text）。 */
function resourceText(result) {
  const contents = Array.isArray(result?.contents) ? result.contents : []
  const first = contents.find((c) => c && typeof c.text === 'string')
  return first ? first.text : ''
}
