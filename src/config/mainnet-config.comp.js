import {useEffect} from "react"
import {config} from "@onflow/config"

// In production the app talks to Flow through the same-origin /flow proxy
// (worker/index.js), which caches script executions at the edge. Plain static
// servers (CRA dev on 3000, `serve` on 5080/5081) have no proxy, so those go
// straight to the public access node.
const PROXYLESS_PORTS = ["3000", "5080", "5081"]

export function MainnetConfig() {
  window.topshotAddress = "0b2a3299cc857e29"
  window.topshotMarketAddress = "c1e4f4f4c4257510"
  useEffect(() => {
    const direct = PROXYLESS_PORTS.includes(window.location.port)
    config().put(
      "accessNode.api",
      direct ? "https://rest-mainnet.onflow.org" : window.location.origin + "/flow"
    )
  }, [])
  return null
}
