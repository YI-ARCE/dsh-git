import z from '@deepseek-ai/schemastery';
import { NS, text, selection, workspace, runGeneration } from './ai-core.js';
export const Config = z.object({ provider: z.string().default('').volatile(), model: z.string().default('').volatile() });
export function apply(host) {
  const controllers = new Set();
  host.effect(() => () => { for (const c of controllers) c.abort(); });
  return (host.get?.('webServer') ?? host.webServer).register({ kind: 'exact', path: '/__git-ai', async handler(req, res) {
    const ctx = Object.fromEntries(['connection', 'settings', 'llm', 'workspaceRegistry', 'sessionQuery'].map(name => [name, host.get?.(name) ?? host[name]]));
    ctx.get = name => host.get?.(name) ?? host[name];
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
    if (!ctx.connection) { reply(503, { error: 'AI 桥依赖未就绪：connection' }); return; }
    const rejected = ctx.connection.requestRejection({ headers: req.headers });
    if (rejected) { reply(rejected, { error: '请重新启动桌面应用以恢复认证' }); return; }
    const missing = ['settings', 'llm', 'workspaceRegistry'].filter(name => !ctx[name]);
    if (!missing.length && !ctx.settings.describe({ redactSecrets: true }).some(row => row.ns === NS)) missing.push(NS);
    if (missing.length) { reply(503, { error: `AI 桥依赖未就绪：${missing.join(', ')}` }); return; }
    if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) { reply(405, { error: '仅接受 JSON POST' }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const close = () => controller.abort();
    res.on('close', close);
    controllers.add(controller);
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 512000) throw new Error('请求内容过大'); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object') throw new Error('请求无效');
      let result;
      switch (data.action) {
        case 'options': {
          const sessions = [];
          // Model settings are global; an unregistered Git directory has no conversation history.
          let ws;
          try { ws = await workspace(ctx, data.path); } catch { /* Keep provider settings available. */ }
          const query = ctx.get?.('sessionQuery');
          for (const id of query ? (ws?.sessionIds?.slice(-40) ?? []) : []) {
            let title = id;
            try { title = (await query.readTitle(id, controller.signal))?.title || id; } catch {}
            sessions.push({ id, title });
          }
          result = { ...selection(ctx), providers: ctx.llm.listProviders().map(x => ({ id: x.id, name: x.name })), sessions };
          break;
        }
        case 'models': {
          const provider = text(data.provider, '服务商');
          if (!ctx.llm.listProviders().some(x => x.id === provider)) throw new Error('服务商不可用');
          result = (await ctx.llm.listModels(provider)).map(x => ({ id: x.id, name: x.name }));
          break;
        }
        case 'save': {
          const provider = text(data.provider, '服务商'), model = text(data.model, '模型');
          if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('设置版本无效，请重新打开设置');
          if (!ctx.llm.listProviders().some(x => x.id === provider)) throw new Error('服务商不可用');
          await ctx.llm.resolveModelInfo(provider, model, controller.signal);
          await ctx.settings.update(NS, { provider, model }, data.revision);
          result = selection(ctx);
          break;
        }
        case 'generate':
          if (controllers.size > 4) throw new Error('生成请求过多，请稍后重试');
          result = await runGeneration(ctx, data, controller.signal);
          break;
        default: throw new Error('未知操作');
      }
      if (controller.signal.aborted) throw new Error('请求已取消或超时');
      reply(200, result);
    } catch (error) {
      // Do not return provider errors: they may include URLs or credentials.
      const message = String(error?.message || '请求失败');
      const safe = /^(请|工作区|所选|服务商|模型|生成|关联|请求|设置|未知|改动摘要)/.test(message) && message.length < 180;
      reply(400, { error: safe ? message : '操作失败，请检查模型设置或重新打开设置后重试' });
    } finally { clearTimeout(timer); res.off('close', close); controllers.delete(controller); }
  } });
}
