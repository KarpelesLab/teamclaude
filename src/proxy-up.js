import net from 'node:net';

// A successful TCP connect is enough to prove a listener is already on the configured address.
/**
 * @param {number} port
 * @param {string} [host]
 * @param {number} [timeout]
 */
export function isProxyUp(port, host = '127.0.0.1', timeout = 600) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    /** @param {boolean} up */
    const done = up => { socket.destroy(); resolve(up); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => resolve(false));
  });
}
