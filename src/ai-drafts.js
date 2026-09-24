// Drafts belong to this browser, owner, document and workflow. Never put them in
// the published DOM or the account vault. Storage failures leave memory intact.
const valid = (v) => v?.schema === 1 && typeof v.prompt === "string" && Array.isArray(v.versions) && v.versions.length <= 5 &&
  v.versions.every((entry) => typeof entry.html === "string" && entry.html.length <= 400000 && typeof entry.prompt === "string" && Number.isSafeInteger(entry.number));

export class AiDrafts {
  constructor(nc, storage) { this.nc = nc; this.storage = storage; this.memory = new Map(); }
  key(kind) {
    if (!this.nc.pubkey) return null;
    return "nsite-clay.ai-draft:" + JSON.stringify([this.nc.pubkey, this.nc.cfg?.path || this.nc.doc.location.pathname, kind]);
  }
  read(kind) {
    const key = this.key(kind); if (!key) return null;
    if (this.memory.has(key)) return this.memory.get(key);
    try {
      const raw = this.storage?.getItem(key);
      if (!raw || raw.length > 2500000) return null;
      const value = JSON.parse(raw);
      if (!valid(value)) return null;
      this.memory.set(key, value); return value;
    } catch { return null; }
  }
  import(kind, text) {
    try {
      if (text.length > 2500000) return false;
      const value = JSON.parse(text); if (!valid(value)) return false;
      if (kind === "edit" && (!['page', 'element'].includes(value.proposalScope || value.scope) || typeof value.before !== "string")) return false;
      this.write(kind, value); return true;
    } catch { return false; }
  }
  write(kind, draft) {
    const key = this.key(kind); if (!key) return false;
    const value = { ...draft, schema: 1, updated: Date.now(), versions: (draft.versions || []).slice(-5) };
    this.memory.set(key, value);
    try {
      if (!this.storage) return false;
      const raw = JSON.stringify(value);
      if (raw.length > 2500000) return false;
      this.storage.setItem(key, raw); return true;
    } catch { return false; }
  }
  clear(kind) {
    const key = this.key(kind); if (!key) return false;
    this.memory.set(key, null);
    try { this.storage?.removeItem(key); return true; } catch { return false; }
  }
}
