import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PUBLIC_SNAPSHOT_SOURCE as SOURCE, parsePublicHomepage, parsePublicMatches, validateSnapshot, snapshotFormat } from "./public-snapshot.mjs";

const FIXTURE = new URL("./fixtures/public-homepage.json", import.meta.url);

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`No se pudo leer la página pública (${response.status}).`);
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error("La respuesta pública supera el tamaño previsto.");
  return html;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !["--fetch", "--dry-run"].includes(arg))) {
    throw new Error("Uso: node scripts/refresh-public-snapshot.mjs [--fetch] [--dry-run]. Solo captura, valida y guarda archivos de referencia.");
  }
  let snapshot;
  if (args.has("--fetch")) {
    const [homepage, matches] = await Promise.all([download(SOURCE), download(`${SOURCE}partidas`)]);
    snapshot = {
      source: SOURCE,
      matchesSource: `${SOURCE}partidas`,
      capturedAt: new Date().toISOString(),
      ...parsePublicHomepage(homepage),
      matches: parsePublicMatches(matches),
    };
  } else {
    snapshot = JSON.parse(await readFile(FIXTURE, "utf8"));
  }
  validateSnapshot(snapshot);
  const save = args.has("--fetch") && !args.has("--dry-run");
  if (save) {
    await mkdir(new URL("./fixtures/", import.meta.url), { recursive: true });
    await writeFile(FIXTURE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  console.log(`Captura ${save ? "guardada" : "validada"} (${snapshotFormat(snapshot)}): ${snapshot.rows.length} participantes, ${snapshot.matches.length} partidas en curso.`);
  console.log("Herramienta de referencia: no importa datos ni modifica la base o las reglas del torneo.");
  console.log(`Capturada: ${snapshot.capturedAt}; actualización pública: ${snapshot.publicSyncFinishedAt ?? "no publicada"}.`);
  console.log(snapshot.rows.slice(0, 4).map((row) => `${row.rank}. ${row.name}: ${row.points} puntos`).join("\n"));
}

main().catch((error) => {
  console.error(error.code ? `No se pudo completar la captura pública (${error.code}).` : error.message);
  process.exitCode = 1;
});
