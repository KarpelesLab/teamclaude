// Minimal pure-JS X.509 certificate generation (no external deps).
//
// node:crypto can create keypairs and sign, but cannot issue certificates, so
// we hand-encode the (small) ASN.1 DER cert envelope and sign the TBS with the
// issuer key. Used only to mint a local CA + a leaf for the MITM proxy, which
// the launched claude process trusts via NODE_EXTRA_CA_CERTS. Nothing here is a
// general-purpose ASN.1 library — just what these two certs need.

import { generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';

// ── ASN.1 DER primitives ──────────────────────────────────────

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) { bytes.unshift(x & 0xff); x = Math.floor(x / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

const seq = (items) => tlv(0x30, Buffer.concat(items));
const set = (items) => tlv(0x31, Buffer.concat(items));
const NULL = Buffer.from([0x05, 0x00]);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octet = (buf) => tlv(0x04, buf);
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf])); // 0 unused bits
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, content) => tlv(0xa0 | n, content);   // [n] constructed
const ctxPrim = (n, content) => tlv(0x80 | n, content);    // [n] primitive

function integer(buf) {
  let b = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from([buf]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++; // strip leading zeros
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // keep positive
  return tlv(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const group = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { group.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(date) {
  const z = (n) => String(n).padStart(2, '0');
  const s = `${z(date.getUTCFullYear() % 100)}${z(date.getUTCMonth() + 1)}${z(date.getUTCDate())}` +
            `${z(date.getUTCHours())}${z(date.getUTCMinutes())}${z(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function pem(der, label) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// ── cert pieces ───────────────────────────────────────────────

const SIG_ALG = seq([oid('1.2.840.113549.1.1.11'), NULL]); // sha256WithRSAEncryption

function nameCN(cn) {
  return seq([set([seq([oid('2.5.4.3'), utf8(cn)])])]); // RDNSequence with one CN
}

function ext(extOid, critical, valueDer) {
  const items = [oid(extOid)];
  if (critical) items.push(bool(true));
  items.push(octet(valueDer));
  return seq(items);
}

// keyUsage BIT STRING from named bit positions (bit 0 = MSB of first byte).
function keyUsage(bits) {
  const max = Math.max(...bits);
  const nbytes = Math.floor(max / 8) + 1;
  const bytes = Buffer.alloc(nbytes);
  for (const b of bits) bytes[Math.floor(b / 8)] |= 0x80 >> (b % 8);
  const unused = nbytes * 8 - (max + 1);
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
}

function buildCert({ subjectCN, issuerCN, spkiDer, signKey, isCA, altDnsNames = [], days }) {
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);          // 1h back for clock skew
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const extList = [];
  extList.push(ext('2.5.29.19', true, isCA ? seq([bool(true)]) : seq([]))); // basicConstraints
  extList.push(ext('2.5.29.15', true, isCA
    ? keyUsage([0, 5, 6])   // digitalSignature, keyCertSign, cRLSign
    : keyUsage([0, 2])));   // digitalSignature, keyEncipherment
  if (!isCA) {
    extList.push(ext('2.5.29.37', false, seq([oid('1.3.6.1.5.5.7.3.1')]))); // extKeyUsage serverAuth
    if (altDnsNames.length) {
      extList.push(ext('2.5.29.17', false, seq(altDnsNames.map((d) => ctxPrim(2, Buffer.from(d)))))); // SAN dNSName
    }
  }

  const tbs = seq([
    explicit(0, integer(Buffer.from([2]))),  // version v3
    integer(randomBytes(16)),                // serial
    SIG_ALG,
    nameCN(issuerCN),
    seq([utcTime(notBefore), utcTime(notAfter)]),
    nameCN(subjectCN),
    spkiDer,                                  // SubjectPublicKeyInfo (already DER)
    explicit(3, seq(extList)),
  ]);

  const signature = cryptoSign('sha256', tbs, signKey); // RSASSA-PKCS1-v1_5
  return pem(seq([tbs, SIG_ALG, bitString(signature)]), 'CERTIFICATE');
}

// ── public API ────────────────────────────────────────────────

function newRsaKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    spkiDer: publicKey.export({ type: 'spki', format: 'der' }),
  };
}

export function createCA(cn = 'TeamClaude Local CA') {
  const key = newRsaKey();
  const certPem = buildCert({
    subjectCN: cn, issuerCN: cn, spkiDer: key.spkiDer, signKey: key.privateKey,
    isCA: true, days: 3650,
  });
  return { cn, certPem, keyPem: key.keyPem, privateKey: key.privateKey };
}

export function createLeaf(hosts, ca) {
  const list = Array.isArray(hosts) ? hosts : [hosts];
  const key = newRsaKey();
  const certPem = buildCert({
    subjectCN: list[0], issuerCN: ca.cn, spkiDer: key.spkiDer, signKey: ca.privateKey,
    isCA: false, altDnsNames: list, days: 825,
  });
  return { certPem, keyPem: key.keyPem };
}

/** Generate a fresh CA + a leaf covering `hosts` (string or array). Returns PEM strings. */
export function generateCertChain(hosts) {
  const ca = createCA();
  const leaf = createLeaf(hosts, ca);
  return {
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    leafCertPem: leaf.certPem,
    leafKeyPem: leaf.keyPem,
  };
}
