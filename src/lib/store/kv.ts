// localStorage soyutlaması. Testte MemoryKV, tarayıcıda LocalStorageKV.
// Okuma/yazma try/catch içinde; bozuk veri varsayılana döner (arayuz-spesifikasyonu.md).

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export class MemoryKV implements KV {
  m = new Map<string, string>();
  get(k: string) { return this.m.get(k) ?? null; }
  set(k: string, v: string) { this.m.set(k, v); }
  remove(k: string) { this.m.delete(k); }
  keys() { return [...this.m.keys()]; }
}

export class LocalStorageKV implements KV {
  get(k: string) { try { return window.localStorage.getItem(k); } catch { return null; } }
  set(k: string, v: string) {
    try { window.localStorage.setItem(k, v); } catch (e) { console.warn("localStorage yazılamadı", k, e); throw e; }
  }
  remove(k: string) { try { window.localStorage.removeItem(k); } catch { /* yok say */ } }
  keys() {
    try { return Object.keys(window.localStorage); } catch { return []; }
  }
}

export const PREFIX = "asena:v1:";
