import net from 'node:net';

// pesalab has no login and binds to localhost, which is right for a test tool.
// But a browser can still be tricked into talking to it:
//
// - Cross-site requests. Any page you visit while pesalab runs can send a POST to
//   http://127.0.0.1:4010. Without a check it could reset the sandbox, resolve
//   prompts, or make pesalab post callbacks to addresses on your network.
// - DNS rebinding. A hostile domain can be made to resolve to 127.0.0.1, so the
//   browser treats pesalab as same-origin with that page and can read its state.
//
// The guard closes both. Browser requests must come from a page on this machine,
// and every request must be addressed to a local or internal host name. Server-side
// clients (your backend, curl, tests) send no Origin header and are unaffected.

const isLoopbackName = (h) =>
  h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);

function hostnameOf(value) {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const list = (v) =>
  (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s).trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);

/**
 * @param {object} [options]
 * @param {string[]|string} [options.allowedHosts]   extra Host names to accept, e.g. "pesalab.mycompany.test"
 * @param {string[]|string} [options.allowedOrigins] extra browser origins to accept, e.g. "https://app.example.com", or "*"
 */
export function createGuard(options = {}) {
  const hosts = new Set(list(options.allowedHosts));
  const origins = new Set(list(options.allowedOrigins));
  const anyOrigin = origins.has('*');

  /**
   * Which Host headers are safe. Loopback names, IP literals and single-label names
   * (Docker service names such as "pesalab") cannot be pointed at us by a stranger's
   * public DNS, so they are allowed. Anything else must be listed explicitly.
   */
  function hostAllowed(header) {
    if (!header) return true; // HTTP/1.0 tools; browsers always send Host
    const h = hostnameOf(header);
    if (!h) return false;
    if (isLoopbackName(h) || hosts.has(h)) return true;
    if (net.isIP(h.replace(/^\[|\]$/g, '')) !== 0) return true;
    return !h.includes('.');
  }

  /** Browser requests must come from a page on this machine, or an origin you allowed. */
  function originAllowed(origin) {
    if (origin === undefined) return true; // not a browser
    if (anyOrigin) return true;
    const o = origin.trim().toLowerCase().replace(/\/+$/, '');
    if (origins.has(o)) return true;
    // Vodacom's OpenAPI makes server clients send "Origin: *". Browsers never send it.
    if (o === '*') return true;
    if (o === 'null') return false; // sandboxed iframes, file:// pages
    const h = hostnameOf(o);
    return Boolean(h) && isLoopbackName(h);
  }

  /** Returns null when the request may proceed, or { status, body } to refuse it. */
  function check(req) {
    const { host, origin } = req.headers;
    if (!hostAllowed(host)) {
      return {
        status: 403,
        body: {
          pesalab: true,
          error: `Refused a request addressed to host "${host}". pesalab only answers requests sent to localhost, an IP address or an internal name.`,
          hint: 'If you reach pesalab through a domain name on purpose, start it with --allow-host <name>.',
        },
      };
    }
    if (!originAllowed(origin)) {
      return {
        status: 403,
        body: {
          pesalab: true,
          error: `Refused a browser request from ${origin}. pesalab only accepts browser requests from pages on this machine.`,
          hint: 'If your front end runs somewhere else on purpose, start pesalab with --allow-origin <origin>.',
        },
      };
    }
    return null;
  }

  return { check, hostAllowed, originAllowed };
}
