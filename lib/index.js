/**
 * dsh-hhxg-market — 插件入口（host 半，无 UI）。
 *
 * 恢恢量化 (hhxg.top) A股量化数据 for DeepSeek Harness：
 *  - 6 个免费工具：日报快照 / 财经快讯 / 融资融券 / A股日历 / 市场情绪 / 题材热度，
 *    直调 hhxg.top 公开端点，零配置可用。
 *  - 5 个 VIP 工具：个股诊断 / 策略信号 / 连板晋级预测 / 异动历史 / 数据集查询，
 *    经 JSON-RPC 桥接 hhxg MCP server；config.mcpToken 未填时注册为引导占位。
 *
 * 全部工具只读（research-only）：本插件不下单、不划转资金、不模拟后转发。
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FREE_TOOLS, VIP_TOOLS, runVipTool, vipLockedMessage } from './tools.js'

export const name = 'hhxg-market'
export const inject = ['tools']

export const Config = z.object({
  mcpToken: z
    .string()
    .role('secret')
    .default('')
    .description('恢恢量化 VIP 会员的 MCP Token（https://hhxg.top/account/mcp.html 生成）。留空时仅免费工具可用。'),
  enableVipTools: z
    .boolean()
    .default(true)
    .description('是否注册 VIP 工具（未填 Token 时以引导占位形式注册）。'),
})

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

export function apply(ctx, config) {
  const token = String(config?.mcpToken || '').trim()

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
    ctx.logger?.info?.('[hhxg-market] VIP 工具已按配置关闭，仅注册 6 个免费工具')
    return
  }

  for (const spec of VIP_TOOLS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!token) return vipLockedMessage(spec.name)
        return runVipTool(spec, token, args, exec?.signal)
      },
    }))
  }

  ctx.logger?.info?.(
    `[hhxg-market] 已注册 ${FREE_TOOLS.length} 个免费工具 + ${VIP_TOOLS.length} 个 VIP 工具` +
    (token ? '（MCP Token 已配置）' : '（未配置 Token，VIP 工具为引导占位）'),
  )
}
