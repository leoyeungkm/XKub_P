import deployment from "@/config/deployment.json";

// Same-origin JSON-RPC proxy: the browser calls /api/rpc, we forward to the
// KUB RPC server-side. Avoids the chain RPC's CORS/preflight quirks entirely.
// The public bitkub RPC has flaky spells, so fall back to a second provider
// before giving up — and keep each upstream attempt short enough that the
// function never hits the platform gateway timeout (Vercel default 10s → 504).
export const maxDuration = 30;

const UPSTREAMS = [
  deployment.rpcUrl,
  "https://25925.rpc.thirdweb.com", // same chain, CORS-friendly, validated fallback
];

export async function POST(req: Request) {
  const body = await req.text();
  let lastErr: unknown = null;
  for (const url of UPSTREAMS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { lastErr = new Error(`upstream ${r.status}`); continue; }
      const text = await r.text();
      return new Response(text, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      lastErr = e; // timeout / network — try the next upstream
    }
  }
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(lastErr) } }),
    { status: 502, headers: { "content-type": "application/json" } },
  );
}
