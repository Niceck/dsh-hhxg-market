/**
 * dsh-hhxg-market — 插件入口（host 半；浏览器半见 lib/client.js，只接管 hhxg_realtime 的结果卡）。
 *
 * 恢恢量化 (hhxg.top) A股量化数据 for DeepSeek Harness：
 *  - 7 个免费工具：日报快照 / 财经快讯 / 融资融券 / A股日历 / 市场情绪 / 题材热度 / 数据集目录，
 *    直调 hhxg.top 公开端点，零配置可用。
 *  - 6 个 VIP 工具：个股诊断 / 策略信号 / 连板晋级预测 / 异动历史 / 数据集查询 / 盘中实时（Max 专属），
 *    经 JSON-RPC 桥接 hhxg MCP server；config.mcpToken 未填时注册为引导占位。
 *
 * 全部工具只读（research-only）：本插件不下单、不划转资金、不模拟后转发。
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveMcpToken } from './api.js'
import { realtimePresentation, renderRealtimeText } from './present.js'
import { FREE_TOOLS, VIP_TOOLS, runVipTool, vipLockedMessage } from './tools.js'

export const name = 'hhxg-market'
export const inject = ['tools']

export const Config = z.object({
  mcpToken: z
    .string()
    .role('secret')
    .default('')
    .description('恢恢量化会员的 MCP Token（Max 会员在 https://hhxg.top/account/mcp.html 生成）。留空时读环境变量 HHXG_MCP_TOKEN；都没有则仅免费工具可用。'),
  enableVipTools: z
    .boolean()
    .default(true)
    .description('是否注册 VIP 工具（未填 Token 时以引导占位形式注册）。'),
})

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

/**
 * 桌面端卡片用的结构化投影：按工具名挑一个 presentationMeta（客户端半 lib/client.js 只认这些 kind）。
 * 投影与文本渲染都从 execute 返回的同一份原文解析（execute 本身不改写原文）：
 * render 给模型 / 用户的文本在首行标出帧日期与时效，presentationMeta 照旧从原 JSON 投影。
 */
const PRESENTATIONS = {
  hhxg_realtime: { present: realtimePresentation, render: renderRealtimeText },
}

function outputFor(name) {
  const entry = PRESENTATIONS[name]
  if (!entry) return TEXT_OUTPUT
  return {
    ...TEXT_OUTPUT,
    render: (args, value) => [{ type: 'text', text: entry.render(args, String(value ?? '')) }],
    presentationMeta: (args, value) => entry.present(args, String(value ?? '')),
  }
}

export function apply(ctx, config) {
  const { token, source } = resolveMcpToken(config)

  for (const spec of FREE_TOOLS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        return spec.run(args, exec?.signal)
      },
    }))
  }

  if (config?.enableVipTools === false) {
    ctx.logger?.info?.(`[hhxg-market] VIP 工具已按配置关闭，仅注册 ${FREE_TOOLS.length} 个免费工具`)
    return
  }

  for (const spec of VIP_TOOLS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: outputFor(spec.name),
      async execute(args, exec) {
        if (!token) return vipLockedMessage(spec.name)
        return runVipTool(spec, token, args, exec?.signal)
      },
    }))
  }

  // 只记来源，绝不记值
  const sourceText = { config: 'MCP Token 来自配置', env: 'MCP Token 来自环境变量 HHXG_MCP_TOKEN', none: '未配置 Token，VIP 工具为引导占位' }[source]
  ctx.logger?.info?.(
    `[hhxg-market] 已注册 ${FREE_TOOLS.length} 个免费工具 + ${VIP_TOOLS.length} 个 VIP 工具（${sourceText}）`,
  )
}
