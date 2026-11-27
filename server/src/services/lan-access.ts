/**
 * Optional LAN access for the local web dev server. Off unless LAN_ALLOWED_HOSTS is set, e.g.
 * LAN_ALLOWED_HOSTS=192.168.1.20. Only the web server is exposed on the network; the API stays on
 * 127.0.0.1 and receives proxied requests. The listed names are the only extra Host/Origin names
 * accepted besides the loopback names.
 */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function configuredLanHostnames(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.LAN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && HOSTNAME.test(value));
}
