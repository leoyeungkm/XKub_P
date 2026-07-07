import deployment from "@/config/deployment.json";

// Same-origin JSON-RPC proxy: the browser calls /api/rpc, we forward to the
// KUB RPC server-side. Avoids the chain RPC's CORS/preflight quirks entirely.
export async function POST(req: Request) {
  const body = await req.text();
  try {
    const r = await fetch(deployment.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(e) } }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
