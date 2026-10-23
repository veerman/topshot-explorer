/*
 * Stands in for @onflow/fcl-wc, FCL's WalletConnect plugin (vite.config.js
 * aliases the package here). FCL imports it statically, but loads it only
 * when `walletconnect.projectId` is configured, and this app configures
 * none, so the plugin never ran: until then it was about 490 KB of the
 * main bundle (148 KB compressed). Wallets connect through FCL Discovery
 * as before (Dapper Wallet, the Flow Wallet extension); a WalletConnect QR
 * code was never available without a project id, and stays unavailable.
 *
 * Same exports as the real package, which, uninitialized, rejects every
 * call with this same error.
 */
const notInitialized = () => Promise.reject(new Error("WalletConnect client not initialized"));

export const SERVICE_PLUGIN_NAME = "fcl-plugin-service-walletconnect";
export const WC_SERVICE_METHOD = "WC/RPC";
export const FLOW_METHODS = {
  FLOW_AUTHN: "flow_authn",
  FLOW_PRE_AUTHZ: "flow_pre_authz",
  FLOW_AUTHZ: "flow_authz",
  FLOW_USER_SIGN: "flow_user_sign"
};
export const getProvider = notInitialized;
export const createSessionProposal = notInitialized;
export const request = notInitialized;
export const init = notInitialized;
export const initLazy = () => {
  throw new Error("WalletConnect is not part of this build (src/shims/fcl-wc.js)");
};
