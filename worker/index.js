// Caching proxy in front of Flow's public access node. The app sends its
// gRPC-web calls to same-origin /flow/*; script executions are cached at the
// edge so popular reads (plays, sets, the home overview) cost the access
// node one execution per five minutes per colo instead of one per visitor.

const FLOW_UPSTREAM = "https://rest-mainnet.onflow.org"
const CACHE_TTL_SECONDS = 300
// only pure reads against latest block are safe to cache
const CACHEABLE_METHODS = ["/flow.access.AccessAPI/ExecuteScriptAtLatestBlock"]

// gRPC-web responses carry their real status in a trailer frame inside the
// body (an error still arrives as HTTP 200), so a response must be parsed
// before it may be cached. Frames are [1 byte flags][4 bytes length][payload];
// the trailer frame has the high flag bit set and holds ASCII headers.
const grpcWebStatus = (bodyBytes, response) => {
  const headerStatus = response.headers.get("grpc-status")
  if (headerStatus !== null) return headerStatus
  const view = new DataView(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength)
  let offset = 0
  while (offset + 5 <= bodyBytes.byteLength) {
    const flags = view.getUint8(offset)
    const length = view.getUint32(offset + 1, false)
    const start = offset + 5
    if (start + length > bodyBytes.byteLength) break
    if (flags & 0x80) {
      const trailer = new TextDecoder().decode(bodyBytes.subarray(start, start + length))
      const match = trailer.match(/grpc-status:\s*(\d+)/i)
      if (match) return match[1]
    }
    offset = start + length
  }
  return null
}

const proxyFlow = async (request, url, ctx) => {
  const upstreamPath = url.pathname.slice("/flow".length)
  const upstreamUrl = FLOW_UPSTREAM + upstreamPath
  const forward = (body) =>
    fetch(upstreamUrl, {
      method: request.method,
      headers: {
        "content-type": request.headers.get("content-type") || "application/grpc-web+proto",
        "x-grpc-web": request.headers.get("x-grpc-web") || "1",
      },
      body,
    })

  if (request.method !== "POST" || !CACHEABLE_METHODS.includes(upstreamPath)) {
    return forward(request.body)
  }

  // key the cache on the exact request body (script text + arguments)
  const requestBytes = await request.arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", requestBytes)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  const cache = caches.default
  const cacheKey = new Request(`${url.origin}/__flow-cache/${hex}`)

  const cached = await cache.match(cacheKey)
  if (cached) {
    const res = new Response(cached.body, cached)
    res.headers.set("x-flow-cache", "HIT")
    return res
  }

  const upstream = await forward(requestBytes)
  // buffer to inspect the trailer; script responses are capped by the access
  // node's computation limit at a few MB
  const bodyBytes = new Uint8Array(await upstream.arrayBuffer())
  const headers = {
    "content-type": upstream.headers.get("content-type") || "application/grpc-web+proto",
    "x-flow-cache": "MISS",
  }
  for (const name of ["grpc-status", "grpc-message"]) {
    const value = upstream.headers.get(name)
    if (value !== null) headers[name] = value
  }

  if (upstream.status === 200 && grpcWebStatus(bodyBytes, upstream) === "0") {
    const stored = new Response(bodyBytes, {
      status: 200,
      headers: {...headers, "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`},
    })
    ctx.waitUntil(cache.put(cacheKey, stored))
  }

  return new Response(bodyBytes, {status: upstream.status, headers})
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/flow/")) {
      try {
        return await proxyFlow(request, url, ctx)
      } catch (err) {
        console.error("flow proxy error:", err)
        return new Response("flow proxy error", {status: 502})
      }
    }
    // only /flow/* is routed here via run_worker_first; anything else that
    // arrives falls through to the asset layer
    return env.ASSETS.fetch(request)
  },
}
