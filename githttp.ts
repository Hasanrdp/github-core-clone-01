// git smart HTTP: ref advertisements (v2 and v0), ls-refs, fetch and
// receive-pack, spoken the way the suite's git client expects it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
} from './store.ts';
import type { Forge, GitObject, ObjectType, Repo } from './store.ts';
import {
  PKT_LINE_MAX_PAYLOAD,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  pktDelim,
  pktFlush,
  readPack,
  sidebandChunks,
  writePack,
} from './pack.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitContext {
  forge: Forge;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  requestId: () => string;
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, sorted by name, with HEAD first when it has a target. */
function repoRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip !== undefined) {
    lines.push({ name: 'HEAD', oid: mainTip, symrefTarget: 'refs/heads/main' });
  }
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

/** The object closure of commits without following parent links (tree only). */
function treeClosure(objects: Map<string, GitObject>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') queue.push(parseCommit(object.data).tree);
    else if (object.type === 'tag') queue.push(parseTag(object.data).object);
    else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Read one pkt-line at `offset`: its kind, payload and the next offset. */
function readPktAt(
  buffer: Buffer,
  offset: number,
): { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer; next: number } {
  if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
  const header = buffer.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
  const length = Number.parseInt(header, 16);
  if (length === 0) return { kind: 'flush', payload: Buffer.alloc(0), next: offset + 4 };
  if (length === 1) return { kind: 'delim', payload: Buffer.alloc(0), next: offset + 4 };
  if (length === 2) return { kind: 'response-end', payload: Buffer.alloc(0), next: offset + 4 };
  if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
  if (offset + length > buffer.length) throw new Error('truncated pkt-line');
  return { kind: 'data', payload: buffer.subarray(offset + 4, offset + length), next: offset + length };
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'object-format=sha1\n',
    'fetch=shallow filter\n',
    'ls-refs=unborn\n',
  ];
  return Buffer.concat([encodePktLines(lines), pktFlush()]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow'
      : 'report-status side-band-64k delete-refs ofs-delta';
  const preamble = `# service=${service}\n`;
  const parts: Buffer[] = [encodePktLine(preamble)];
  const refs = repoRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(encodePktLine(line));
    });
    // A peeled tag gets its ^{} line after its own line.
    const extra: Buffer[] = [];
    for (const ref of refs) {
      if (ref.peeled !== undefined) extra.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
    parts.push(...extra);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GitContext,
  repo: Repo,
  service: string,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    ctx.sendJson(res, 400, { message: 'unknown service' });
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  const type = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
  sendBytes(res, 200, type, body, ctx.requestId());
}

function lsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  let refs = repoRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    refs = [{ name: 'HEAD', oid: ZERO_OID, symrefTarget: 'refs/heads/main', unborn: true }];
  }
  if (prefixes.length > 0) {
    refs = refs.filter((ref) => prefixes.some((prefix) => ref.name.startsWith(prefix)));
  }
  const lines: string[] = [];
  for (const ref of refs) {
    if (ref.unborn === true) {
      lines.push(`unborn ${ref.name}${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return Buffer.concat([encodePktLines(lines), pktFlush()]);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

function selectFetchObjects(repo: Repo, args: FetchArgs): FetchSelection {
  const shallowIn = new Set(args.shallow);
  const held = collectReachable(repo.objects, args.haves, shallowIn);
  const wantedTags: string[] = [];
  const wantCommits: string[] = [];
  for (const oid of args.wants) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantedTags.push(oid);
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null) wantCommits.push(peeled);
    } else if (object.type === 'commit') {
      wantCommits.push(oid);
    }
  }

  let ack: string | null = null;
  for (const have of args.haves) {
    if (wantCommits.some((want) => isAncestor(repo.objects, have, want)) || wantCommits.includes(have)) {
      ack = have;
      break;
    }
  }

  const wanted = new Set<string>();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (args.depth === undefined) {
    for (const oid of collectReachable(repo.objects, [...wantCommits, ...wantedTags])) wanted.add(oid);
    for (const boundary of shallowIn) shallowOut.push(boundary);
  } else {
    const seenCommits = new Set<string>();
    const queue: Array<{ oid: string; gen: number }> = wantCommits.map((oid) => ({ oid, gen: 1 }));
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; gen: number };
      if (seenCommits.has(item.oid)) continue;
      seenCommits.add(item.oid);
      const object = repo.objects.get(item.oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (item.gen > args.depth) continue;
      if (item.gen === args.depth) shallowOut.push(item.oid);
      for (const oid of treeClosure(repo.objects, [item.oid])) wanted.add(oid);
      if (item.gen < args.depth) {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: item.gen + 1 });
      }
    }
    for (const oid of wantedTags) wanted.add(oid);
    for (const boundary of shallowIn) {
      if (seenCommits.has(boundary)) unshallowOut.push(boundary);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: shallowOut, unshallow: unshallowOut, ack };
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args);
  const parts: Buffer[] = [];
  const ackLines = ['acknowledgments\n'];
  if (selection.ack !== null) ackLines.push(`ACK ${selection.ack}\n`, 'ready\n');
  else ackLines.push('NAK\n');
  parts.push(encodePktLines(ackLines));
  parts.push(pktDelim());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    const lines = ['shallow-info\n'];
    for (const oid of selection.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of selection.unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(lines));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(selection.objects);
  parts.push(...sidebandChunks(1, pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args);
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (selection.ack !== null) lines.push(`ACK ${selection.ack}\n`);
  else lines.push('NAK\n');
  for (const oid of selection.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of selection.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  const pack = writePack(selection.objects);
  parts.push(...sidebandChunks(1, pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GitContext,
  repo: Repo,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    ctx.sendJson(res, 400, { message: 'could not read the request body' });
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    ctx.sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  const isV2 = req.headers['git-protocol'] === 'version=2';
  try {
    if (first === 'command=ls-refs') {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      for (const line of lines.slice(1)) {
        const text = line.replace(/\n$/, '');
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      }
      sendBytes(res, 200, UPLOAD_RESULT, lsRefsResponse(repo, prefixes, peel, symrefs), ctx.requestId());
      return;
    }
    if (first === 'command=fetch') {
      const args = parseFetchArgs(lines.slice(1));
      sendBytes(res, 200, UPLOAD_RESULT, fetchV2Response(repo, args), ctx.requestId());
      return;
    }
    if (isV2) {
      ctx.sendJson(res, 400, { message: `unknown v2 command ${JSON.stringify(first)}` });
      return;
    }
    // v0 fetch: want/have/done lines in one or two sections.
    const args = parseFetchArgs(lines);
    sendBytes(res, 200, UPLOAD_RESULT, fetchV0Response(repo, args), ctx.requestId());
  } catch (err) {
    ctx.sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad fetch request' });
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GitContext,
  repo: Repo,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    ctx.sendJson(res, 400, { message: 'could not read the request body' });
    return;
  }
  const commands: PushCommand[] = [];
  let offset = 0;
  let unpackError: string | null = null;
  try {
    for (;;) {
      const packet = readPktAt(body, offset);
      offset = packet.next;
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const line = text.replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error('bad push command line');
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch (err) {
    unpackError = err instanceof Error ? err.message : 'bad command list';
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    const packBytes = body.subarray(offset);
    let unpackOk = true;
    let unpackDetail = 'ok';
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    if (needsPack && packBytes.length > 0) {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'pack did not parse';
      }
    } else if (needsPack && packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing packfile';
    }
    reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
    if (unpackOk) {
      for (const command of commands) {
        const result = applyPushCommand(repo, command);
        reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
      }
    } else {
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
    }
  }

  const report = Buffer.concat([encodePktLines(reportLines), pktFlush()]);
  const framed = Buffer.concat([...sidebandChunks(1, report), pktFlush()]);
  sendBytes(res, 200, RECEIVE_RESULT, framed, ctx.requestId());
}

function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    if (current === ZERO_OID) return { ok: false, reason: 'reference does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  const target = repo.objects.get(command.newOid);
  if (target === undefined) return { ok: false, reason: 'object not found' };
  if (command.oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return { ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  const tip = peelToCommit(repo.objects, command.newOid) ?? command.newOid;
  const oldTip = peelToCommit(repo.objects, current) ?? current;
  if (!isAncestor(repo.objects, oldTip, tip)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

/** Route a git smart-HTTP request. `rest` is the path after `<owner>/<repo>.git`. */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GitContext,
  owner: string,
  repoName: string,
  rest: string,
  query: URLSearchParams,
): Promise<boolean> {
  const repo = ctx.forge.getRepo(owner, repoName);
  if (repo === undefined) {
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (req.method === 'GET' && rest === '/info/refs') {
    handleInfoRefs(req, res, ctx, repo, query.get('service') ?? '');
    return true;
  }
  if (req.method === 'POST' && rest === '/git-upload-pack') {
    await handleUploadPack(req, res, ctx, repo);
    return true;
  }
  if (req.method === 'POST' && rest === '/git-receive-pack') {
    await handleReceivePack(req, res, ctx, repo);
    return true;
  }
  return false;
}

export { PKT_LINE_MAX_PAYLOAD };
