// githttp.ts — git smart HTTP: protocol v2 upload-pack, v0 receive-pack.
//
// The rules the kit states (competition.yaml): upload-pack must speak
// protocol v2 (the suite requests it with Git-Protocol: version=2; the v2
// advertisement and both ls-refs checks require it). Receive-pack is v0
// only and must advertise report-status, side-band-64k and delete-refs.
// Both advertisements open with the "# service=..." preamble on v0 and
// "version 2" on v2; a missing repository is 404 on both services' info/refs
// and the server stays up.
//
// Outgoing packs carry whole objects only (no deltas): the suite verifies
// hashes and counts, never delta presence, and whole objects let the clone
// workload reuse the deflate cache in pack.ts.

import {
  ZERO_OID,
  parseTag,
  type Repo,
  type Store,
} from './store.ts';
import { planFetch, readPackEntries, writePack } from './pack.ts';

/** What app.ts hands a handler for a git route. */
export interface GitCtx {
  method: string;
  /** The owner and repository name from the path. */
  owner: string;
  repo: string;
  /** The service query (?service=git-upload-pack / git-receive-pack). */
  service: string;
  /** The raw request body (a Buffer for POSTs, null for GETs). */
  body: Buffer | null;
}

export interface GitResp {
  status: number;
  body: Buffer | string | Record<string, unknown> | null;
  headers?: Record<string, string>;
}

const AGENT = 'git-forge/1.0.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The v2 capability advertisement: identical for every repository. */
const V2_ADVERTISEMENT = (() => {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
})();

// ---------------------------------------------------------------------------
// Pkt-line framing
// ---------------------------------------------------------------------------

/** One pkt-line: 4 hex length digits + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

/** A flush packet (0000). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** A delimiter packet (0001). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a pkt-line stream; throws on a bad length or truncation. */
export function decodePktLines(buf: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = Number.parseInt(buf.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1 || len === 2) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  if (offset !== buf.length) throw new Error('trailing bytes in pkt-line stream');
  return packets;
}

/**
 * Decode pkt-lines up to the first flush; returns the packets and the
 * untouched remainder (a receive-pack's pack follows the flush raw).
 */
function decodeUntilFlush(buf: Buffer): { packets: DecodedPacket[]; rest: Buffer } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = Number.parseInt(buf.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (len === 1 || len === 2) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  throw new Error('pkt-line stream ends without a flush');
}

/** Wrap bytes in sideband band-1 packets (max 65515 data bytes each). */
function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const max = 65515;
  for (let offset = 0; offset < data.length; offset += max) {
    const chunk = data.subarray(offset, Math.min(offset + max, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

/** The v0 receive-pack advertisement for one repository's refs. */
function receiveAdvertisement(repo: Repo): Buffer {
  const capabilities = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=' + AGENT + ' symref=HEAD:refs/heads/' + repo.defaultBranch;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  const refs: { oid: string; name: string }[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined) refs.push({ oid: headTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) refs.push({ oid: repo.refs.get(name) as string, name });
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${capabilities}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

/** Split a v2 request body into its command and argument lines. */
function parseV2Request(body: Buffer): V2Request {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    const text = packet.payload.toString('utf8');
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length).trim();
    } else {
      args.push(text.replace(/\n$/, ''));
    }
  }
  if (command === '') throw new Error('no command in upload-pack request');
  return { command, args };
}

/** Peel a tag object to the commit it names (following tag chains). */
function peelTag(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** Answer a v2 ls-refs command. */
function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      const symref = symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : '';
      parts.push(pktLine(`${headTip} HEAD${symref}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel && name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        suffix = ` peeled:${peelTag(repo, oid)}`;
      }
    }
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer a v2 fetch command. */
function handleFetch(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.add(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowIn.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, shallowIn);
  const pack = writePack(plan.entries);
  const parts: Buffer[] = [];
  // The acknowledgments section is only sent when the client sent haves:
  // a client with nothing in common skips reading it and expects the next
  // section (real git fails the fetch otherwise). Every have the server
  // holds is ACKed, and `ready` always closes the section: the client sent
  // `done`, so the server must say the negotiation is over and the pack
  // follows — a bare NAK leaves the client waiting for another round.
  if (haves.size > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let acked = 0;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked += 1;
      }
    }
    if (acked === 0) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  const wantedRefs: { oid: string; ref: string }[] = [];
  for (const want of wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wantedRefs.push({ oid, ref: name });
    }
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const entry of wantedRefs) parts.push(pktLine(`${entry.oid} ${entry.ref}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, body: Buffer | null): GitResp {
  if (body === null) return { status: 400, body: { message: 'empty upload-pack request' } };
  let request: V2Request;
  try {
    request = parseV2Request(body);
  } catch (err) {
    return { status: 400, body: { message: err instanceof Error ? err.message : 'malformed upload-pack request' } };
  }
  if (request.command === 'ls-refs') {
    return { status: 200, body: handleLsRefs(repo, request.args), headers: { 'content-type': UPLOAD_RESULT } };
  }
  if (request.command === 'fetch') {
    return { status: 200, body: handleFetch(repo, request.args), headers: { 'content-type': UPLOAD_RESULT } };
  }
  return { status: 400, body: { message: `unknown upload-pack command ${request.command}` } };
}

// ---------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  capabilities: string[];
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer | null): GitResp {
  if (body === null) return { status: 400, body: { message: 'empty receive-pack request' } };
  let packets: DecodedPacket[];
  let packBytes: Buffer;
  try {
    const decoded = decodeUntilFlush(body);
    packets = decoded.packets;
    packBytes = decoded.rest;
  } catch (err) {
    return { status: 400, body: { message: err instanceof Error ? err.message : 'malformed receive-pack request' } };
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const line = nul < 0 ? text : text.slice(0, nul);
    const capabilities = nul < 0 ? [] : text.slice(nul + 1).split(' ').filter(Boolean);
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string, capabilities });
  }
  const useSideband = commands.length > 0 && commands[0]?.capabilities.includes('side-band-64k') === true;
  const reportLines: string[] = [];
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  // Unpack the pack first: every update needs its objects, deletes need none.
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const parsed = readPackEntries(packBytes, repo);
      for (const entry of parsed.entries) {
        // putObject records creation order for commits (listCommits sorts
        // newest first) and skips objects the repo already holds.
        store.putObject(repo, entry.type, entry.data);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (hasUpdates) {
    unpackOk = false;
    unpackDetail = 'unpacker error: no pack received';
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update: the old value must match and the move must fast-forward.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        const obj = repo.objects.get(command.newOid);
        const isCommit = obj !== undefined && obj.type === 'commit';
        const fastForward = isCommit && store.isAncestor(repo, command.oldOid, command.newOid);
        if (!fastForward) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
      }
    }
    repo.branchesJson = null;
  } else {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
    }
  }
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat(reportLines.map((line) => pktLine(line)));
  // The report-status stream inside band 1 is itself pkt-lined and must end
  // with its own flush: the reader demultiplexes band 1 and then reads the
  // report as a pkt-line stream, and an EOF before that flush is "the remote
  // end hung up". The outer flush then ends the sideband stream itself.
  const bodyOut = useSideband
    ? Buffer.concat([sideband(Buffer.concat([report, pktFlush()])), pktFlush()])
    : Buffer.concat([report, pktFlush()]);
  return { status: 200, body: bodyOut, headers: { 'content-type': RECEIVE_RESULT } };
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export function handleGit(store: Store, ctx: GitCtx): GitResp {
  const repo = store.getRepo(ctx.owner, ctx.repo);
  if (repo === undefined) {
    return { status: 404, body: { message: 'Not Found' } };
  }
  if (ctx.method === 'GET') {
    if (ctx.service === 'git-upload-pack') {
      return { status: 200, body: V2_ADVERTISEMENT, headers: { 'content-type': UPLOAD_ADVERTISEMENT } };
    }
    if (ctx.service === 'git-receive-pack') {
      return { status: 200, body: receiveAdvertisement(repo), headers: { 'content-type': RECEIVE_ADVERTISEMENT } };
    }
    return { status: 400, body: { message: 'unknown service' } };
  }
  if (ctx.method === 'POST') {
    if (ctx.service === 'git-upload-pack') return handleUploadPack(repo, ctx.body);
    if (ctx.service === 'git-receive-pack') return handleReceivePack(store, repo, ctx.body);
    return { status: 400, body: { message: 'unknown service' } };
  }
  return { status: 405, body: { message: 'Method Not Allowed' } };
}
