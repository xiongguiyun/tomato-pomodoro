// 番茄钟同步接口：/api/data?key=xxxx（静态资源由 env.ASSETS 提供）
const MAX_BODY = 900000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/data")) {
      if (!env.POMODORO_KV) {
        return json({ error: "KV 未绑定：请在 Worker → 设置 → 绑定中添加 POMODORO_KV" }, 500);
      }
      const key = (url.searchParams.get("key") || "").trim();
      if (!/^[\w-]{8,64}$/.test(key)) return json({ error: "无效的同步码" }, 400);
      const id = `tomato:${key}`;

      if (request.method === "GET") {
        return json(await env.POMODORO_KV.get(id, "type json"));
      }
      if (request.method === "PUT" || request.method === "POST") {
        const body = await request.text();
        if (body.length > MAX_BODY) return json({ error: "数据过大" }, 413);
        try { JSON.parse(body); } catch (_) { return json({ error: "非法 JSON" }, 400); }
        await env.POMODORO_KV.put(id, body, { expirationTtl: 60 * 60 * 24 * 365 });
        return json({ ok: true });
      }
      return json({ error: "不支持的方法" }, 405);
    }

    return env.ASSETS.fetch(request);
  },
};
