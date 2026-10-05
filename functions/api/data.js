// Cloudflare Pages Function：跨设备同步 API（跟随 GitHub 仓库自动部署）
// 路由: /api/data?key=xxxx
// GET  → 返回该同步码的数据（JSON），无数据返回 null
// PUT  → 保存数据（最后写入者胜）

const MAX_BODY = 900000; // ~0.9MB，KV 单值上限 25MB，留足余量防滥用

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.POMODORO_KV) {
    return json({ error: "KV 未绑定：请在 Pages 项目 → Settings → Functions 中绑定 POMODORO_KV" }, 500);
  }

  const url = new URL(request.url);
  const key = (url.searchParams.get("key") || "").trim();

  // 同步码校验：8-64 位可见字符，防止随意遍历
  if (!/^[\w-]{8,64}$/.test(key)) {
    return json({ error: "无效的同步码" }, 400);
  }
  const id = `tomato:${key}`;

  if (request.method === "GET") {
    const value = await env.POMODORO_KV.get(id, "type json");
    return json(value);
  }

  if (request.method === "PUT" || request.method === "POST") {
    const body = await request.text();
    if (body.length > MAX_BODY) return json({ error: "数据过大" }, 413);
    try {
      JSON.parse(body);
    } catch (_) {
      return json({ error: "非法 JSON" }, 400);
    }
    await env.POMODORO_KV.put(id, body, { expirationTtl: 60 * 60 * 24 * 365 }); // 保留 1 年
    return json({ ok: true });
  }

  return json({ error: "方法不允许" }, 405);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
