// Peer-to-peer networking via PeerJS (WebRTC). The host's browser runs the
// game; players connect straight to it. PeerJS's free public broker is used
// only to introduce browsers to each other — game traffic goes peer to peer.

const PREFIX = 'futbolpoker-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function needPeer() {
  if (!window.Peer) throw new Error('Networking library failed to load — check your internet connection.');
}

/** Open a room. Resolves { peer, code } once the broker has registered it. */
export function hostRoom({ onConnection, onError }, attempts = 4) {
  needPeer();
  return new Promise((resolve, reject) => {
    const code = makeCode();
    const peer = new window.Peer(PREFIX + code.toLowerCase(), { debug: 1 });
    let opened = false;
    peer.on('open', () => { opened = true; resolve({ peer, code }); });
    peer.on('connection', conn => onConnection(conn));
    peer.on('error', err => {
      if (!opened && err.type === 'unavailable-id' && attempts > 1) {
        peer.destroy();
        hostRoom({ onConnection, onError }, attempts - 1).then(resolve, reject);
      } else if (!opened) reject(err);
      else onError?.(err);
    });
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  });
}

/** Connect to a room. Resolves { peer, conn } once the data channel is open. */
export function joinRoom(code, { onError } = {}) {
  needPeer();
  return new Promise((resolve, reject) => {
    const peer = new window.Peer({ debug: 1 });
    let done = false;
    const fail = e => { if (!done) { done = true; peer.destroy(); reject(e); } };
    const t = setTimeout(() => fail(new Error('Could not reach that table. Check the code, and that the host still has the game open.')), 15000);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code.toLowerCase(), { reliable: true });
      conn.on('open', () => { done = true; clearTimeout(t); resolve({ peer, conn }); });
      conn.on('error', fail);
    });
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') fail(new Error(`No table found with code ${code}.`));
      else if (!done) fail(err);
      else onError?.(err);
    });
  });
}
