import fs from "node:fs/promises";

const DATA_PATH = process.env.DATA_PATH || "data.json";
const BADGES_MAP_PATH = process.env.BADGES_MAP_PATH || "badges_map.json";
const MISSING_BADGE = process.env.MISSING_BADGE || "assets/escudos/_missing.png";

// Tu league.id -> ESPN league code
const ESPN_LEAGUE = {
  ucl: "uefa.champions",
  arg: "arg.1",
  de: "ger.1",
  es: "esp.1",
  it: "ita.1",
  eng: "eng.1",
  fra: "fra.1"
};

const ARG_OFFSET_HOURS = 3; // -03:00 fijo

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normalizeTeamName(s) {
  // Normalización fuerte para matchear ESPN vs tu mapa
  // - minúsculas
  // - sin acentos
  // - sin puntos/dobles espacios
  // - cambia & por "and"
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")      // saca acentos
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")        // saca símbolos raros
    .replace(/\s+/g, " ")                // colapsa espacios
    .trim();
}

function getArgentinaYmd() {
  const now = new Date();
  const arg = new Date(now.getTime() - ARG_OFFSET_HOURS * 3600_000);
  return `${arg.getUTCFullYear()}-${pad2(arg.getUTCMonth() + 1)}-${pad2(arg.getUTCDate())}`;
}

function ymdToEspnDates(ymd) {
  return ymd.replaceAll("-", "");
}

function toArgentinaISOFromUTC(utcIso) {
  const d = new Date(utcIso);
  const arg = new Date(d.getTime() - ARG_OFFSET_HOURS * 3600_000);

  const y = arg.getUTCFullYear();
  const m = pad2(arg.getUTCMonth() + 1);
  const day = pad2(arg.getUTCDate());
  const hh = pad2(arg.getUTCHours());
  const mm = pad2(arg.getUTCMinutes());
  const ss = pad2(arg.getUTCSeconds());

  return `${y}-${m}-${day}T${hh}:${mm}:${ss}-03:00`;
}

function formatDateTextArgentina(argIso) {
  const dt = new Date(argIso);

  const weekday = new Intl.DateTimeFormat("es-AR", {
    weekday: "short",
    timeZone: "America/Argentina/Buenos_Aires"
  }).format(dt);

  const day = new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    timeZone: "America/Argentina/Buenos_Aires"
  }).format(dt);

  const month = new Intl.DateTimeFormat("es-AR", {
    month: "numeric",
    timeZone: "America/Argentina/Buenos_Aires"
  }).format(dt);

  const time = new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires"
  }).format(dt);

  return `${weekday}, ${day}/${month}, ${time}`;
}

async function fetchScoreboard(espnLeagueCode, ymd) {
  const dates = ymdToEspnDates(ymd);
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${espnLeagueCode}/scoreboard?dates=${dates}`;
  const r = await fetch(url, { headers: { "user-agent": "data-json-updater/1.0" } });
  if (!r.ok) throw new Error(`ESPN ${espnLeagueCode} HTTP ${r.status}: ${await r.text()}`);
  return await r.json();
}

function buildFooter(comp) {
  const st = comp?.status?.type ?? {};
  const state = st?.state || "";   // pre / in / post
  const detail = st?.detail || "";

  if (state === "in") return `EN VIVO · ${detail}`.trim();
  if (state === "post") return `Final · ${detail}`.trim();
  return detail || "";
}

function pickLocalBadge(badgesMap, leagueId, teamName) {
  const norm = normalizeTeamName(teamName);
  const leagueMap = badgesMap?.leagues?.[leagueId] ?? {};
  return leagueMap[norm] || badgesMap?.meta?.missingBadge || MISSING_BADGE;
}

function parseFixture(scoreboardJson, leagueNameForItem, leagueId, badgesMap, maxItems = 12) {
  const events = scoreboardJson?.events ?? [];
  const fixture = [];

  for (const ev of events) {
    const comp = ev?.competitions?.[0];
    if (!comp) continue;

    const competitors = comp?.competitors ?? [];
    const home = competitors.find((c) => c?.homeAway === "home");
    const away = competitors.find((c) => c?.homeAway === "away");

    const utcIso = comp?.date || ev?.date;
    if (!utcIso) continue;

    const dateISO = toArgentinaISOFromUTC(utcIso);
    const dateText = formatDateTextArgentina(dateISO);

    const homeTeam = home?.team ?? {};
    const awayTeam = away?.team ?? {};

    const homeName = homeTeam?.displayName || homeTeam?.shortDisplayName || "";
    const awayName = awayTeam?.displayName || awayTeam?.shortDisplayName || "";

    fixture.push({
      league: leagueNameForItem,
      dateISO,
      dateText,
      home: {
        name: homeName,
        badge: pickLocalBadge(badgesMap, leagueId, homeName)
      },
      away: {
        name: awayName,
        badge: pickLocalBadge(badgesMap, leagueId, awayName)
      },
      footer: buildFooter(comp)
    });
  }

  fixture.sort((a, b) => {
    const aLive = a.footer?.startsWith("EN VIVO") ? 0 : 1;
    const bLive = b.footer?.startsWith("EN VIVO") ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    return (a.dateISO || "").localeCompare(b.dateISO || "");
  });

  return fixture.slice(0, maxItems);
}

async function main() {
  const raw = await fs.readFile(DATA_PATH, "utf-8");
  const json = JSON.parse(raw);

  const badgesRaw = await fs.readFile(BADGES_MAP_PATH, "utf-8");
  const badgesMap = JSON.parse(badgesRaw);

  const ymd = getArgentinaYmd();

  for (const lg of json.leagues || []) {
    const code = ESPN_LEAGUE[lg.id];
    if (!code) continue;

    const sb = await fetchScoreboard(code, ymd);

    const leagueNameForItem =
      (lg.subtitle?.split("·")?.[1]?.trim()) || lg.name || lg.label || "";

    lg.fixture = parseFixture(sb, leagueNameForItem, lg.id, badgesMap, 12);
  }

  await fs.writeFile(DATA_PATH, JSON.stringify(json, null, 2) + "\n", "utf-8");
  console.log(`OK: updated ${DATA_PATH} for ${ymd} using LOCAL badges`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
