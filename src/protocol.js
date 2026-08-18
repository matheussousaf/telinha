// Bumped whenever the WebSocket message shapes change. Pages compare this to
// their own compiled-in copy (web/src/api.js) and tell the user to refresh on
// mismatch — long-lived SPA tabs otherwise fail silently after a deploy.
export const PROTOCOL_VERSION = 5; // v5: media moved from P2P mesh to LiveKit SFU
