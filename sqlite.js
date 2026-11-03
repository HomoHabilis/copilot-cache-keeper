// Minimal read-only SQLite reader: enough to list the rows of one table, including pages still in
// the write-ahead log (-wal). Used to read VS Code's agent-host.db, which links a Copilot SDK chat
// as VS Code knows it (agent-host-copilotcli:/<id>) to its log folder (~/.copilot/session-state/<id>).
// No dependency: the extension ships without node modules, and the file can be on a remote machine.
"use strict";

function varint(buf, pos) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const b = buf[pos + i];
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) return [v, pos + i + 1];
  }
  return [v * 256 + buf[pos + 8], pos + 9];
}

/** Latest committed version of each page found in the WAL, as page number -> Buffer. */
function walPages(wal, pageSize) {
  const pages = new Map();
  if (!wal || wal.length < 32) return pages;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return pages;
  const size = wal.readUInt32BE(8) || pageSize;
  const salt1 = wal.readUInt32BE(16), salt2 = wal.readUInt32BE(20);
  let pending = new Map();
  for (let off = 32; off + 24 + size <= wal.length; off += 24 + size) {
    // frames left over from an earlier WAL generation carry other salts: they end the valid part
    if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) break;
    pending.set(wal.readUInt32BE(off), wal.subarray(off + 24, off + 24 + size));
    if (wal.readUInt32BE(off + 4)) {          // commit frame: everything up to here is committed
      for (const [k, v] of pending) pages.set(k, v);
      pending = new Map();
    }
  }
  return pages;
}

function openDb(db, wal) {
  if (!db || db.length < 100 || db.toString("latin1", 0, 15) !== "SQLite format 3") return null;
  let pageSize = db.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  const usable = pageSize - db[20];
  const fromWal = walPages(wal, pageSize);
  const page = n => fromWal.get(n) || db.subarray((n - 1) * pageSize, n * pageSize);
  return { page, usable };
}

/** The record (column values) stored in one table-leaf cell, following overflow pages. */
function cellRecord(d, buf, pos) {
  let size, rowid;
  [size, pos] = varint(buf, pos);
  [rowid, pos] = varint(buf, pos);
  const U = d.usable, X = U - 35;
  let payload;
  if (size <= X) payload = buf.subarray(pos, pos + size);
  else {
    const M = Math.floor((U - 12) * 32 / 255) - 23;
    const K = M + (size - M) % (U - 4);
    const local = K <= X ? K : M;
    const parts = [buf.subarray(pos, pos + local)];
    let got = local, next = buf.readUInt32BE(pos + local), guard = 0;
    while (next && got < size && guard++ < 100000) {
      const p = d.page(next);
      const take = Math.min(U - 4, size - got);
      parts.push(p.subarray(4, 4 + take));
      got += take;
      next = p.readUInt32BE(0);
    }
    payload = Buffer.concat(parts);
  }
  return { rowid, values: decodeRecord(payload) };
}

function decodeRecord(p) {
  let [hdr, pos] = varint(p, 0);
  const types = [];
  while (pos < hdr) { let t; [t, pos] = varint(p, pos); types.push(t); }
  let at = hdr;
  return types.map(t => {
    if (t === 0) return null;
    if (t === 8) return 0;
    if (t === 9) return 1;
    if (t >= 1 && t <= 6) {
      const n = [0, 1, 2, 3, 4, 6, 8][t];
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + p[at + i];
      if (p[at] & 0x80) v -= Math.pow(2, 8 * n);    // two's complement
      at += n;
      return v;
    }
    if (t === 7) { const v = p.readDoubleBE(at); at += 8; return v; }
    const n = Math.floor((t - (t % 2 ? 13 : 12)) / 2);
    const v = t % 2 ? p.toString("utf8", at, at + n) : p.subarray(at, at + n);
    at += n;
    return v;
  });
}

/** All rows of the table b-tree rooted at `root`, in rowid order. */
function tableRows(d, root) {
  const rows = [];
  const seen = new Set();
  const walk = n => {
    if (!n || seen.has(n)) return;          // a damaged file must not loop forever
    seen.add(n);
    const buf = d.page(n);
    const h = n === 1 ? 100 : 0;
    const type = buf[h], count = buf.readUInt16BE(h + 3);
    const cells = h + (type === 0x05 ? 12 : 8);
    for (let i = 0; i < count; i++) {
      const at = buf.readUInt16BE(cells + 2 * i);
      if (type === 0x0d) rows.push(cellRecord(d, buf, at));
      else if (type === 0x05) walk(buf.readUInt32BE(at));
    }
    if (type === 0x05) walk(buf.readUInt32BE(h + 8));
  };
  walk(root);
  return rows;
}

/** Column names from a CREATE TABLE statement. */
function columnsOf(sql) {
  const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
  const cols = [];
  let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { cols.push(cur); cur = ""; } else cur += ch;
  }
  cols.push(cur);
  return cols.map(c => c.trim()).filter(c => c && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(c))
    .map(c => c.split(/\s+/)[0].replace(/^["`[]|["`\]]$/g, ""));
}

/** Rows of table `name` as objects ({} per row), or null if the file or table can't be read. */
function readTable(db, wal, name) {
  try {
    const d = openDb(db, wal);
    if (!d) return null;
    const master = tableRows(d, 1).map(r => r.values);
    const t = master.find(v => v[0] === "table" && v[1] === name);
    if (!t) return null;
    const cols = columnsOf(t[4]);
    return tableRows(d, t[3]).map(r => Object.fromEntries(cols.map((c, i) => [c, r.values[i] === undefined ? null : r.values[i]])));
  } catch { return null; }
}

/**
 * Copilot SDK log id (sdkSessionId) -> the id VS Code opens the chat by, from agent-host.db.
 * `db`, `wal`: file contents (Buffer; wal may be null).
 */
function sdkChatIds(db, wal) {
  const map = new Map();
  for (const table of ["session_chats", "chats_v2"]) {      // newer table last: it wins
    for (const r of readTable(db, wal, table) || []) {
      const owner = String(r.owner_session_uri || r.session_uri || "");
      const m = /^copilotcli:\/+([^/?#]+)$/.exec(owner);
      const sdk = /"sdkSessionId"\s*:\s*"([^"]+)"/.exec(String(r.provider_data || ""));
      if (m && sdk) map.set(sdk[1], m[1]);
    }
  }
  return map;
}

module.exports = { readTable, sdkChatIds, columnsOf };
