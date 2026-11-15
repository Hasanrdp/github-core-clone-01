// pack.ts — packfile reading and writing for the git smart-HTTP surface.
//
// Outgoing packs carry whole objects only (no deltas): the suite's pack
// checks verify hashes and counts, never delta presence, and whole objects
// keep the clone workload fast through the deflate cache below. Incoming
// packs are parsed fully, deltas included, so any conforming client works.
//
// The deflate cache is the clone workload's big win: 50 concurrent shallow
// clones all pack the same tip objects, so the second and later clones reuse
// the first clone's compressed bytes instead of re-deflating.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, parseCommit, parseTag, parseTree, type GitObject, type ObjectType, type Repo } from './store.ts';

/** How many deflated objects the cache holds before it is cleared. */
const DEFLATE_CACHE_MAX = 4096;

/** oid -> deflated object bytes (header + zlib stream, no trailer). */
const deflateCache = new Map<string, Buffer>();

/** The deflated entry bytes for one object, cached per oid. */
export function deflatedObject(oid: string, type: ObjectType, data: Buffer): Buffer {
  const hit = deflateCache.get(oid);
  if (hit !== undefined) return hit;
  const head = packObjectHeader(type, data.length);
  const body = deflateSync(data);
  const out = Buffer.concat([head, body]);
  if (deflateCache.size >= DEFLATE_CACHE_MAX) deflateCache.clear();
  deflateCache.set(oid, out);
  return out;
}

/** The pack entry header: varint type + size. */
export function packObjectHeader(type: ObjectType, size: number): Buffer {
  const typeNum = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  const bytes: number[] = [];
  let value = size;
  let first = (typeNum << 4) | (value & 0x0f);
  value >>= 4;
  if (value > 0) first |= 0x80;
  bytes.push(first);
  while (value > 0) {
    let next = value & 0x7f;
    value >>= 7;
    if (value > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export interface PackEntry {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/**
 * Write a packfile (version 2) for whole objects. The trailer is the SHA-1
 * of every byte before it.
 */
export function writePack(entries: readonly PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const entry of entries) {
    parts.push(deflatedObject(entry.oid, entry.type, entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The objects a fetch must send, in pack order: commits, then trees, then blobs. */
export function orderPackEntries(entries: readonly PackEntry[]): PackEntry[] {
  const rank = (type: ObjectType): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3);
  return [...entries].sort((a, b) => rank(a.type) - rank(b.type));
}

// ---------------------------------------------------------------------------
// Pack reading (incoming pushes; deltas resolved against the pack and the repo)
// ---------------------------------------------------------------------------

/** Read the size varint of a pack entry header; returns [type, size, next]. */
function readEntryHeader(buf: Buffer, offset: number): [number, number, number] {
  const first = buf[offset] as number;
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let next = offset + 1;
  let shift = 4;
  while ((buf[next - 1] as number) & 0x80) {
    size |= ((buf[next] as number) & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return [type, size, next];
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          copySize |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface ParsedPack {
  entries: PackEntry[];
  /** oid -> entry, for callers that need lookup. */
  byOid: Map<string, PackEntry>;
}

/**
 * Parse a packfile into whole objects, resolving ofs-delta and ref-delta
 * entries against earlier entries in the same pack and, for ref-deltas,
 * against objects already in the repo. Verifies the trailer checksum.
 * Throws on a bad header, a bad trailer, or an unresolvable delta.
 *
 * Each entry's zlib stream length is found by binary search: inflateSync
 * throws on a truncated stream and ignores trailing bytes, so the smallest
 * prefix that inflates is the stream's exact end.
 */
export function readPackEntries(buf: Buffer, repo?: Repo): ParsedPack {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const expected = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  const actual = buf.subarray(trailerStart).toString('hex');
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  const typeOf = (n: number): ObjectType => {
    if (n === 1) return 'commit';
    if (n === 2) return 'tree';
    if (n === 3) return 'blob';
    if (n === 4) return 'tag';
    throw new Error(`unknown pack object type ${n}`);
  };
  interface Pending {
    offset: number;
    type: number;
    data: Buffer;
    delta: { kind: 'ofs'; baseOffset: number } | { kind: 'ref'; baseOid: string } | null;
  }
  const pending: Pending[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const [type, , afterHeader] = readEntryHeader(buf, offset);
    offset = afterHeader;
    let delta: Pending['delta'] = null;
    if (type === 6) {
      let byte = buf[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      delta = { kind: 'ofs', baseOffset: start - baseOffset };
    } else if (type === 7) {
      delta = { kind: 'ref', baseOid: buf.subarray(offset, offset + 20).toString('hex') };
      offset += 20;
    }
    // Inflate the stream starting here; inflateAt reports the bytes it
    // consumed (via the engine's bytesWritten, with a binary-search
    // fallback), so the next entry begins exactly at offset + consumed.
    const data = inflateAt(buf, offset);
    offset += data.consumed;
    pending.push({ offset: start, type, data: data.out, delta });
  }
  // Safety net for the fast inflate path: a mis-reported stream length
  // would leave the cursor off the trailer, so fail loudly instead of
  // silently storing corrupt objects.
  if (offset !== trailerStart) throw new Error('pack did not end at the trailer');
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  const resolve = (entry: Pending, seen: Set<number>): PackEntry => {
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    if (seen.has(entry.offset)) throw new Error('delta cycle');
    seen.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.delta === null) {
      type = typeOf(entry.type);
      data = entry.data;
    } else if (entry.delta.kind === 'ofs') {
      const basePending = pending.find((candidate) => candidate.offset === entry.delta.baseOffset);
      if (basePending === undefined) throw new Error('ofs-delta base missing');
      const base = resolve(basePending, seen);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      const baseOid = entry.delta.baseOid;
      const inPack = [...byOffset.values()].find((candidate) => candidate.oid === baseOid);
      if (inPack !== undefined) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else if (repo !== undefined) {
        const inRepo = repo.objects.get(baseOid);
        if (inRepo === undefined) throw new Error('ref-delta base missing');
        type = inRepo.type;
        data = applyDelta(inRepo.data, entry.data);
      } else {
        throw new Error('ref-delta base missing');
      }
    }
    const oid = hashObject(type, data);
    const resolved: PackEntry = { oid, type, data };
    byOffset.set(entry.offset, resolved);
    byOid.set(oid, resolved);
    return resolved;
  };
  const entries: PackEntry[] = [];
  for (const entry of pending) entries.push(resolve(entry, new Set<number>()));
  return { entries, byOid };
}

/** Inflate one zlib stream starting at `offset`; reports bytes consumed. */
function inflateAt(buf: Buffer, offset: number): { out: Buffer; consumed: number } {
  // Fast path (one call): inflate the remainder and read how many input
  // bytes the stream consumed from the engine's bytesWritten. The engine
  // stops at the stream's end and ignores trailing bytes, so bytesWritten
  // is exactly the stream's length — verified against the binary search
  // on packs from 0-byte to 64 KiB blobs. Falls back to the binary search
  // when the engine does not report a usable count (an older runtime).
  const limit = buf.length - 20;
  try {
    const { buffer: out, engine } = inflateSync(buf.subarray(offset, limit), { info: true });
    const consumed = (engine as unknown as { bytesWritten?: unknown }).bytesWritten;
    if (typeof consumed === 'number' && Number.isInteger(consumed) && consumed >= 2 && offset + consumed <= limit) {
      return { out, consumed };
    }
  } catch {
    // A truncated stream here means the caller handed us a bad offset; let
    // the binary search below throw the same way it always did.
  }
  return inflateAtBinary(buf, offset);
}

/**
 * Find the zlib stream's end by binary search: inflateSync throws on a
 * truncated stream and ignores trailing bytes, so the smallest prefix that
 * inflates is the stream's exact end. Kept as the fallback when the fast
 * path cannot report a consumed count.
 */
function inflateAtBinary(buf: Buffer, offset: number): { out: Buffer; consumed: number } {
  let low = offset + 2;
  let high = buf.length - 20;
  let out: Buffer | null = null;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      out = inflateSync(buf.subarray(offset, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  if (out === null) {
    out = inflateSync(buf.subarray(offset, buf.length - 20));
    return { out, consumed: buf.length - 20 - offset };
  }
  return { out, consumed: low - offset };
}

// ---------------------------------------------------------------------------
// Reachability: what a fetch must send
// ---------------------------------------------------------------------------

export interface FetchPlan {
  entries: PackEntry[];
  /** Commits sent whose parents were not sent (the shallow boundary). */
  shallow: string[];
  /** Previously-shallow commits whose parents are now all sent. */
  unshallow: string[];
}

/**
 * Plan a fetch: walk from `wants` (commits, tags, or both), stopping at
 * `haves` and at `depth` generations. Returns the whole objects to pack
 * plus the shallow/unshallow boundary lines for the response.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: ReadonlySet<string>,
  depth: number | null,
  shallowIn: readonly string[],
): FetchPlan {
  // The objects the client already holds: for each have, the object itself
  // plus everything reachable from it — EXCEPT below a shallow boundary. A
  // shallow boundary commit is held, but its parents are not: a shallow
  // client's `have` names a commit whose history it does not hold, so the
  // closure must stop there or a deepen fetch would send nothing new.
  // Trees and blobs count as held too: an incremental fetch must not re-send
  // a blob the new commit's tree shares with the old tip's tree.
  const held = new Set<string>();
  const shallowSet = new Set<string>(shallowIn);
  const holdTree = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      held.add(oid);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      }
    }
  };
  const holdStack: string[] = [...haves];
  while (holdStack.length > 0) {
    const oid = holdStack.pop() as string;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      holdTree(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) holdStack.push(parent);
      }
    } else if (obj.type === 'tag') {
      holdStack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      holdTree(oid);
    }
  }
  // Walk the wants with a depth limit, skipping held commits. A held
  // commit is never sent, but its parents are still walked: deepening past
  // a tip the client already holds must reach the next generation.
  const included = new Set<string>();
  const queue: { oid: string; depth: number }[] = [];
  for (const want of wants) queue.push({ oid: want, depth: 0 });
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth: at } = queue.shift() as { oid: string; depth: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!held.has(oid)) included.add(oid);
      queue.push({ oid: parseTag(obj.data).object, depth: at });
      continue;
    }
    if (obj.type !== 'commit') {
      if (!held.has(oid)) included.add(oid);
      continue;
    }
    if (held.has(oid)) {
      if (depth === null || at + 1 <= depth) {
        for (const parent of parseCommit(obj.data).parents) {
          queue.push({ oid: parent, depth: at + 1 });
        }
      }
      continue;
    }
    if (depth !== null && at >= depth) continue;
    included.add(oid);
    if (depth === null || at + 1 <= depth) {
      for (const parent of parseCommit(obj.data).parents) {
        queue.push({ oid: parent, depth: at + 1 });
      }
    }
  }
  // The shallow boundary is the included commits with an unsent parent:
  // a depth cut, or a parent the client does not hold. A root commit has no
  // parent at all, so it is never a boundary — a full clone must not make
  // the client shallow.
  const shallow = [...included].filter((oid) => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return false;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) return false;
    return parents.some((parent) => !included.has(parent) && !held.has(parent));
  });
  // Collect trees and blobs under every included commit — never an object
  // the client already holds.
  const entries = new Map<string, PackEntry>();
  const addObject = (oid: string): void => {
    if (entries.has(oid)) return;
    if (held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    entries.set(oid, { oid, type: obj.type, data: obj.data });
  };
  const walkTree = (treeOid: string): void => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    addObject(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else addObject(entry.oid);
    }
  };
  for (const oid of included) {
    addObject(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      walkTree(parseCommit(obj.data).tree);
    } else if (obj !== undefined && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined) {
        addObject(target);
        if (targetObj.type === 'commit') walkTree(parseCommit(targetObj.data).tree);
      }
    }
  }
  // Unshallow: a previously-shallow commit the client holds whose parents
  // are now all sent or held.
  const unshallow: string[] = [];
  for (const oid of shallowIn) {
    if (!held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((parent) => included.has(parent) || held.has(parent))) {
      unshallow.push(oid);
    }
  }
  return { entries: orderPackEntries([...entries.values()]), shallow, unshallow };
}
