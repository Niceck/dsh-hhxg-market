/**
 * dsh-hhxg-market — 数据层：经 hhxg.top MCP server（JSON-RPC 2.0）与数据 API（REST GET），同一把 Bearer mcpToken 鉴权。
 *
 * 三个方法：
 *  - mcpCall:         tools/call —— 调用服务端一个正式工具，返回其文本结果。
 *  - mcpReadResource: resources/read —— 按 URI 读一份只读资源（KB 信封 / 日历 / 数据集索引），返回解析后的 JSON。
 *  - dataApiGet:      GET /api/data/<path> —— 目前只有 hist（历史库下载：表清单 / 周期 / 限时下载链接），
 *                     返回 { ok: true, body } 或业务答复 { ok: false, code, label, message }。
 *
 * 全部只读（下载接口只签发链接，本插件不下载文件）。任何网络/协议错误都归一为带用户可读 message 的 Error，
 * 不向上抛裸响应体；错误信息经 scrub 脱敏，绝不回显 token。
 */

import { createRequire } from 'node:module'

export const BASE_URL = 'https://hhxg.top'
export const MCP_RPC_URL = `${BASE_URL}/mcp/rpc`
/** 数据 API（REST）前缀：与 MCP 收同一把 AI 接入 Token，按会员限流。 */
export const DATA_API_URL = `${BASE_URL}/api/data`
/**
 * 历史库下载文件的主机与端口（查询服务对外地址，即服务端 QUERY_SERVICE_URL 的 origin）：hhxg_history_download
 * 只展示这个主机上、路径与查询串同服务端格式的链接，也只为它生成下载命令（端口可省）。
 * 站方换下载域名 / 端口时要发新版插件，否则新链接一律被当成不合规、不展示。
 */
export const HIST_DOWNLOAD_HOST = 'query.yzzt.top'
export const HIST_DOWNLOAD_PORT = '2087'
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
 * 带重试地跑一次请求：边缘函数实例冷启动时约 2–3% 的首请求会被平台以 545 击杀，隔几百毫秒重试即好。
 * 全部请求都是只读查询（下载接口重签同一文件当天不另计额度），重试无副作用；
 * 只对 attempt 抛出的 RetryableError（5xx / 部署中途的坏响应）重试一次，401 / 4xx / 业务错误不重试。
 */
async function withRetry(signal, attempt, fallback) {
  let lastErr = null
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS, signal)
    try {
      return await attempt()
    } catch (err) {
      if (!(err instanceof RetryableError)) throw err
      lastErr = err
    }
  }
  throw new Error(lastErr?.message || fallback)
}

/** 一次 JSON-RPC 请求（含重试）：返回 payload.result。 */
function mcpRequest(tok, method, params, signal) {
  return withRetry(signal, () => mcpAttempt(tok, method, params, signal), 'hhxg MCP 暂时不可用，请稍后重试')
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

/**
 * 数据 API 允许的路径（白名单）→ 报错时的服务名。路径不在这里一律不发请求（同 resources/read 只认 hhxg:// URI）。
 * hist = 历史库下载（服务端 _lib/hist_download.js，2026-11-18）：只签发限时下载链接，文件由下载服务器直接发送。
 */
const DATA_API_PATHS = Object.freeze({ hist: '历史库下载服务' })

/**
 * REST 业务答复（code → 给模型看的前缀）：不是故障，是这次的参数 / 取法服务端不接受并说明了原因，
 * 或者文件没有、当天额度用完、这个接口在服务端还没上线（SCOPE_NOT_FOUND）。只在 4xx 时认。
 */
const REST_BUSINESS_CODES = new Map([
  ['INVALID_ARG', '参数有误'],
  ['NOT_FOUND', '无结果'],
  ['NO_DATA', '暂无数据'],
  ['DOWNLOAD_QUOTA_EXCEEDED', '下载额度已用完'],
  ['SCOPE_NOT_FOUND', '暂不支持'],
])
/** 401 / 403 之外也按鉴权处理的码：会员记录不存在（服务端回 404 VIP_NOT_FOUND）。 */
const REST_ACCESS_CODES = new Set(['VIP_NOT_FOUND'])
const REST_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/

/** 服务端说明文字：脱敏、压成单行、限长（多行文本进模型上下文能伪造结构）。 */
function oneLine(msg, tok, limit = 120) {
  return scrub(typeof msg === 'string' ? msg : '', tok).replace(/\s+/g, ' ').trim().slice(0, limit)
}

/**
 * GET /api/data/<path>?<query>：query 里只发非空字符串值（URLSearchParams 编码，不拼字符串）。
 * 返回 { ok: true, body }（2xx 且 body 是 JSON 对象）或 { ok: false, code, label, message }（REST_BUSINESS_CODES 里的 4xx）；
 * 鉴权 / 权益失败给换 Token 或升级 Max 的指引，限流、5xx（重试一次后）、网络与响应异常都抛出带服务名的 Error。
 */
export async function dataApiGet(token, path, query, signal) {
  if (typeof path !== 'string' || !Object.hasOwn(DATA_API_PATHS, path)) {
    throw new Error('内部错误：非法数据接口路径')
  }
  const tok = normalizeToken(token)
  const url = new URL(`${DATA_API_URL}/${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (typeof value === 'string' && value) url.searchParams.set(key, value)
  }
  const service = DATA_API_PATHS[path]
  return withRetry(signal, () => restAttempt(tok, url.href, service, signal), `${service}暂不可用，请稍后再试`)
}

/** 单次 REST 尝试；5xx 抛 RetryableError 交给 withRetry 决定是否重试。 */
function restAttempt(tok, url, service, signal) {
  return withDeadline(signal, async (sig) => {
    let resp
    try {
      resp = await rawFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${tok}` } }, sig)
    } catch (err) {
      throw new Error(`${service}网络不可用（${scrub(err?.message || err, tok)}），请稍后重试`)
    }
    let body = null
    try {
      body = await readJson(resp)
    } catch (err) {
      if (err?.name === 'AbortError' || sig.aborted) throw new Error('请求已取消或超时，请稍后重试')
      body = null
    }
    const isObj = Boolean(body) && typeof body === 'object' && !Array.isArray(body)
    const code = isObj && typeof body.code === 'string' && REST_CODE_RE.test(body.code) ? body.code : ''
    if (resp.status === 401 || resp.status === 403 || REST_ACCESS_CODES.has(code)) {
      throw accessError(code || `HTTP ${resp.status}`)
    }
    if (resp.ok) {
      if (!isObj || body.success === false) throw new Error(`${service}响应异常（HTTP ${resp.status}），请稍后重试`)
      return { ok: true, body }
    }
    const label = resp.status < 500 ? REST_BUSINESS_CODES.get(code) : undefined
    if (label) return { ok: false, code, label, message: oneLine(isObj ? body.error || body.message : '', tok) }
    if (code === 'RATE_LIMIT_EXCEEDED') {
      const wait = body.retry_after_seconds
      const hint = Number.isInteger(wait) && wait >= 1 && wait <= 120 ? `约 ${wait} 秒后再试` : '请稍后再试'
      throw new Error(`${service}请求过于频繁（RATE_LIMIT_EXCEEDED），${hint}`)
    }
    const tag = `HTTP ${resp.status}${code ? ` ${code}` : ''}`
    if (resp.status >= 500) throw new RetryableError(`${service}暂不可用（${tag}），请稍后再试`)
    const detail = oneLine(isObj ? body.error || body.message : '', tok, 200)
    throw new Error(`${service}请求失败（${tag}${detail ? `：${detail}` : ''}），请检查参数后重试`)
  })
}

/** 渲染好的文本出插件前再脱敏一次（兜底：任何上游字段都不该带出 token 原文）。 */
export function redactToken(text, token) {
  return scrub(text, String(token ?? '').trim())
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
