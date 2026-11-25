// Compatibility hint only; differing revisions never reject an existing bridge.
export const bridgeProtocolRevision = 1;

export function sessionWebUrl(value, bridgePort) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, "");
  if (Number(url.port || (url.protocol === "https:" ? 443 : 80)) === bridgePort
    && (host === "localhost" || host.endsWith(".localhost") || /^127\.\d/.test(host) || host === "0.0.0.0"
      || host === "[::1]" || host === "[::]" || /^\[::ffff:7f[\da-f]{2}:/i.test(host))) return null;
  if (host === "chromewebstore.google.com" || (host === "chrome.google.com" && /^\/webstore(?:\/|$)/i.test(url.pathname))
    || (host === "microsoftedge.microsoft.com" && /^\/addons(?:\/|$)/i.test(url.pathname))) return null;
  return url;
}
