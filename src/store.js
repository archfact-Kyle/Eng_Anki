// Storage layer: local (IndexedDB → localStorage → memory) + optional cloud sync (claude db capability).
// Data is split into "buckets" (≤ BUCKET_SIZE notes each) so one review only rewrites one small document.

export const BUCKET_SIZE = 60;

// ---------- Local KV ----------
function openIDB() {
  return new Promise((resolve) => {
    try {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open('ankiwords', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
      setTimeout(() => resolve(null), 3000);
    } catch (e) { resolve(null); }
  });
}

class LocalKV {
  constructor() { this.idb = null; this.mem = new Map(); this.mode = 'memory'; }
  async init() {
    this.idb = await openIDB();
    if (this.idb) { this.mode = 'indexeddb'; return; }
    try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); this.mode = 'localstorage'; } catch (e) { this.mode = 'memory'; }
  }
  async getAll() {
    const out = {};
    if (this.mode === 'indexeddb') {
      try {
        await new Promise((res, rej) => {
          const tx = this.idb.transaction('kv', 'readonly');
          const st = tx.objectStore('kv');
          const req = st.openCursor();
          req.onsuccess = () => { const c = req.result; if (c) { out[c.key] = c.value; c.continue(); } else res(); };
          req.onerror = () => rej(req.error);
        });
        return out;
      } catch (e) { return out; }
    }
    if (this.mode === 'localstorage') {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('aw:')) out[k.slice(3)] = JSON.parse(localStorage.getItem(k));
        }
      } catch (e) {}
      return out;
    }
    for (const [k, v] of this.mem) out[k] = v;
    return out;
  }
  async set(key, value) {
    if (this.mode === 'indexeddb') {
      try {
        await new Promise((res, rej) => {
          const tx = this.idb.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(value, key);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
        return true;
      } catch (e) { return false; }
    }
    if (this.mode === 'localstorage') {
      try { localStorage.setItem('aw:' + key, JSON.stringify(value)); return true; } catch (e) { return false; }
    }
    this.mem.set(key, value); return true;
  }
}

// ---------- Store ----------
export class Store {
  constructor() {
    this.local = new LocalKV();
    this.notes = new Map();      // id -> note
    this.meta = { u: 0, settings: {}, days: {} };
    this.buckets = new Map();    // bucketKey -> Set(noteId)
    this.dirtyLocal = new Set(); // keys
    this.dirtyCloud = new Set();
    this.cloud = null;           // {db, coll, metaRef}
    this.cloudStatus = 'off';    // off | connecting | on | error
    this.listeners = new Set();
    this._localTimer = null; this._cloudTimer = null; this._cloudBusy = false;
  }
  onChange(fn) { this.listeners.add(fn); }
  emit(kind) { for (const fn of this.listeners) try { fn(kind); } catch (e) { console.error(e); } }

  async init() {
    await this.local.init();
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    const all = await this.local.getAll();
    for (const [k, v] of Object.entries(all)) {
      if (k === 'meta') this.meta = Object.assign(this.meta, v);
      else if (k.startsWith('b')) this._ingestBucket(k, v, false);
    }
  }

  _ingestBucket(key, body, fromRemote) {
    const notes = (body && body.notes) || {};
    let changed = false;
    if (!this.buckets.has(key)) this.buckets.set(key, new Set());
    for (const [id, n] of Object.entries(notes)) {
      const cur = this.notes.get(id);
      if (!cur || (n.u || 0) > (cur.u || 0)) {
        n.b = key;
        this.notes.set(id, n);
        this.buckets.get(key).add(id);
        changed = true;
      } else if (fromRemote && (cur.u || 0) > (n.u || 0)) {
        this.dirtyCloud.add(key); // our copy is newer: push it back
      }
    }
    if (fromRemote) {
      // notes we have in this bucket that the remote lacks → push
      for (const id of this.buckets.get(key)) if (!notes[id]) this.dirtyCloud.add(key);
    }
    return changed;
  }

  liveNotes() { return [...this.notes.values()].filter((n) => !n.del); }

  _pickBucket() {
    let best = null;
    for (const [k, set] of this.buckets) if (set.size < BUCKET_SIZE) { best = k; break; }
    if (!best) {
      let i = 0; while (this.buckets.has('b' + i)) i++;
      best = 'b' + i; this.buckets.set(best, new Set());
    }
    return best;
  }

  putNote(note) {
    note.u = Date.now();
    if (!note.b) note.b = this._pickBucket();
    if (!this.buckets.has(note.b)) this.buckets.set(note.b, new Set());
    this.buckets.get(note.b).add(note.id);
    this.notes.set(note.id, note);
    this._markDirty(note.b);
  }
  deleteNote(id) {
    const n = this.notes.get(id); if (!n) return;
    // tombstone keeps sync correct across devices; heavy fields dropped
    const t = { id: n.id, b: n.b, del: true, u: Date.now() };
    this.notes.set(id, t);
    this._markDirty(n.b);
  }
  putMeta(mut) {
    mut(this.meta); this.meta.u = Date.now();
    this._markDirty('meta');
  }
  _bucketBody(key) {
    if (key === 'meta') return this.meta;
    const notes = {};
    for (const id of this.buckets.get(key) || []) {
      const n = this.notes.get(id); if (!n) continue;
      const c = Object.assign({}, n); delete c.b; notes[id] = c;
    }
    return { notes };
  }
  _markDirty(key) {
    this.dirtyLocal.add(key); this.dirtyCloud.add(key);
    clearTimeout(this._localTimer);
    this._localTimer = setTimeout(() => this.flushLocal(), 250);
    this._scheduleCloud();
  }
  async flushLocal() {
    const keys = [...this.dirtyLocal]; this.dirtyLocal.clear();
    for (const k of keys) await this.local.set(k, JSON.parse(JSON.stringify(this._bucketBody(k))));
  }

  // ---------- Cloud (claude.ai artifact db) ----------
  async connectCloud() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    this.cloudStatus = 'connecting'; this.emit('cloud');
    try {
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      const uid = user ? await user.id() : null;
      if (!db || !uid) { this.cloudStatus = 'off'; this.emit('cloud'); return; }
      const coll = db.collection('data/users/' + uid);
      this.cloud = { db, coll };
      const timer = setTimeout(() => { if (this.cloudStatus === 'connecting') { this.cloudStatus = 'error'; this.emit('cloud'); } }, 10000);
      coll.onSnapshot((snap) => {
        clearTimeout(timer);
        let changed = false;
        for (const ch of snap.docChanges()) {
          if (ch.type === 'removed') continue;
          const body = ch.doc.data(); const id = ch.doc.id;
          if (ch.doc.metadata.hasPendingWrites) continue;
          if (id === 'meta') {
            if ((body.u || 0) > (this.meta.u || 0)) { this.meta = Object.assign({ settings: {}, days: {} }, body); changed = true; this.dirtyLocal.add('meta'); }
            else if ((body.u || 0) < (this.meta.u || 0)) this.dirtyCloud.add('meta');
          } else if (id.startsWith('b')) {
            if (this._ingestBucket(id, body, true)) { changed = true; this.dirtyLocal.add(id); }
          }
        }
        if (!snap.metadata.fromCache) {
          // first authoritative snapshot: push everything the cloud lacks
          const remoteIds = new Set(snap.docs.map((d) => d.id));
          for (const k of this.buckets.keys()) if (!remoteIds.has(k) && this.buckets.get(k).size) this.dirtyCloud.add(k);
          if (!remoteIds.has('meta') && this.meta.u) this.dirtyCloud.add('meta');
          this.cloudStatus = 'on'; this.emit('cloud');
        }
        if (this.dirtyLocal.size) { clearTimeout(this._localTimer); this._localTimer = setTimeout(() => this.flushLocal(), 250); }
        if (changed) this.emit('data');
        this._scheduleCloud();
      }, (err) => { clearTimeout(timer); console.warn('db', err); this.cloudStatus = 'error'; this.emit('cloud'); });
    } catch (e) { console.warn(e); this.cloudStatus = 'error'; this.emit('cloud'); }
  }
  _scheduleCloud() {
    if (!this.cloud || this.cloudStatus !== 'on') return;
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this.flushCloud(), 1500);
  }
  async flushCloud() {
    if (!this.cloud || this._cloudBusy) return;
    this._cloudBusy = true;
    try {
      while (this.dirtyCloud.size) {
        const k = this.dirtyCloud.values().next().value; this.dirtyCloud.delete(k);
        const body = JSON.parse(JSON.stringify(this._bucketBody(k)));
        try { await this.cloud.coll.doc(k).set(body); }
        catch (e) {
          if (e && e.code === 'unavailable') { await new Promise((r) => setTimeout(r, 800 + Math.random() * 800)); this.dirtyCloud.add(k); continue; }
          console.warn('cloud write', k, e); this.cloudStatus = 'error'; this.emit('cloud'); break;
        }
      }
    } finally { this._cloudBusy = false; }
  }

  exportJSON() {
    return JSON.stringify({ app: 'ankiwords', v: 1, exported: new Date().toISOString(), meta: this.meta, notes: this.liveNotes().map((n) => { const c = Object.assign({}, n); delete c.b; return c; }) });
  }
  importJSON(text) {
    const d = JSON.parse(text);
    if (!d || !Array.isArray(d.notes)) throw new Error('형식이 올바르지 않습니다');
    let added = 0;
    for (const n of d.notes) {
      if (!n.id || !n.text) continue;
      const cur = this.notes.get(n.id);
      if (cur && !cur.del && (cur.u || 0) >= (n.u || 0)) continue;
      const c = Object.assign({}, n); delete c.b; if (cur) c.b = cur.b;
      this.putNote(c); added++;
    }
    if (d.meta && d.meta.settings) this.putMeta((m) => { m.settings = Object.assign({}, m.settings, d.meta.settings); for (const [k, v] of Object.entries(d.meta.days || {})) if (!m.days[k]) m.days[k] = v; });
    return added;
  }
}
