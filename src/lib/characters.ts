// Seed'li rastgele karakter atama (karakterler/README.md): mulberry32(hash(seed + musteriId)).
import type { CharacterAssignment, Difficulty } from "./domain/types";
import type { Repo } from "./store/repo";

function hash(s: string) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function assignCharacters(repo: Repo, ids: string[], seed: string, difficulty: Difficulty, force: boolean) {
  const lib = repo.characterLibrary();
  const all = repo.customers();
  const usedArk = new Set<string>();
  let hardUsed = 0;
  for (const c of all) {
    if (!ids.includes(c.id)) continue;
    if (c.karakter?.elleDuzenlendi && !force) continue;
    const rnd = mulberry32(hash(seed + c.id));
    const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
    const freeArk = lib.arketipler.filter((a) => !usedArk.has(a.id));
    const ark = pick(freeArk.length ? freeArk : lib.arketipler);
    usedArk.add(ark.id);
    const mags = lib.magduriyetler.filter((m) => (difficulty === "kolay" ? m.yogunluk <= 1 : difficulty === "zor" ? m.yogunluk >= 2 : true));
    const profs = lib.profiller.filter((p) => (difficulty === "kolay" ? ["P1", "P2", "P3"].includes(p.id) : difficulty === "zor" ? ["P4", "P5", "P6", "P7"].includes(p.id) : true));
    const nSap = difficulty === "kolay" ? 0 : difficulty === "zor" ? 1 + Math.floor(rnd() * 2) : Math.floor(rnd() * 2);
    const pool = [...ark.egilim_sapmalar, ...lib.sapmalar.map((s) => s.id)];
    const sap: string[] = [];
    for (let i = 0; i < 20 && sap.length < nSap; i++) {
      const id = i < ark.egilim_sapmalar.length ? ark.egilim_sapmalar[i] : pick(pool);
      const def = lib.sapmalar.find((s) => s.id === id);
      if (!def || sap.includes(id)) continue;
      if (def.sert_durdurma && (difficulty !== "zor" || hardUsed >= 2)) continue;
      if (def.sert_durdurma) hardUsed++;
      sap.push(id);
    }
    const k: CharacterAssignment = { arketipId: ark.id, magduriyetId: pick(mags).id, musaitlikProfilId: pick(profs).id, sapmaIds: sap, seed, elleDuzenlendi: false };
    c.karakter = k;
  }
  // En az bir A12 kontrol vakası
  const chosen = all.filter((c) => ids.includes(c.id));
  if (chosen.length && !chosen.some((c) => c.karakter?.arketipId === "A12")) {
    const target = chosen.find((c) => !c.karakter?.elleDuzenlendi || force);
    if (target?.karakter) target.karakter = { ...target.karakter, arketipId: "A12" };
  }
  repo.saveCustomers(all);
}
