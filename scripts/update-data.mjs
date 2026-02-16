import fs from "node:fs/promises";
import path from "node:path";

const DATA_PATH = process.env.DATA_PATH || "data.json";
const ASSETS_ESCUDOS_DIR = "assets/escudos";
const MISSING_BADGE = "assets/escudos/_missing.png";

const ESPN_LEAGUE = {
  ucl: "uefa.champions",
  arg: "arg.1",
  de: "ger.1",
  es: "esp.1",
  it: "ita.1",
  eng: "eng.1",
  fra: "fra.1"
};

const ARG_OFFSET_HOURS = 3;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normalizeName(s) {
  return (s ?? "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function getArgentinaYmd() {
  const now = new Date();
  const arg = new Date(now.getTime() - ARG_OFFSET_HOURS * 3600_000);
  return `${arg.getUTCFullYear()}-${pad2(arg.getUTCMonth()+1)}-${pad2(arg.getUTCDate())}`;
}

function ymdToEspnDates(ymd) {
  return ymd.replaceAll("-", "");
}

function toArgentinaISO(utcIso) {
  const d = new Date(utcIso);
  const arg = new Date(d.getTime() - ARG_OFFSET_HOURS * 3600_000);
  const y = arg.getUTCFullYear();
  const m = pad2(arg.getUTCMonth()+1);
  const day = pad2(arg.getUTCDate());
  const hh = pad2(arg.getUTCHours());
  const mm = pad2(arg.getUTCMinutes());
  const ss = pad2(arg.getUTCSeconds());
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}-03:00`;
}

function formatDateText(argIso) {
  const dt = new Date(argIso);
  const weekday = new Intl.DateTimeFormat("es-AR", { weekday: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(dt);
  const day = new Intl.DateTimeFormat("es-AR", { day: "numeric", timeZone: "America/Argentina/Buenos_Aires" }).format(dt);
  const month = new Intl.DateTimeFormat("es-AR", { month: "numeric", timeZone: "America/Argentina/Buenos_Aires" }).format(dt);
  const time = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Argentina/Buenos_Aires" }).format(dt);
  return `${weekday}, ${day}/${month}, ${time}`;
}

async function fetchScoreboard(code, ymd) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${ymdToEspnDates(ymd)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("ESPN error " + r.status);
  return await r.json();
}

function footer(comp) {
  const st = comp?.status?.type ?? {};
  if (st.state === "in") return `EN VIVO · ${st.detail}`;
  if (st.state === "post") return `Final · ${st.detail}`;
  return st.detail || "";
}

/* ========= AUTO MAPA DE ESCUDOS ========= */

async function buildBadgeIndex() {
  const index = {};

  async function walk(dir, leagueKey) {
    const files = await fs.readdir(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await walk(full, path.basename(full));
      } else if (f.endsWith(".png") || f.endsWith(".webp")) {
        const team = normalizeName(f.replace(/\.(png|webp)/, ""));
        index[team] = full.replace(/\\/g, "/");
      }
    }
  }

  await walk(ASSETS_ESCUDOS_DIR, "");
  return index;
}

function pickLocalBadge(index, teamName) {
  const key = normalizeName(teamName);
  return index[key] || MISSING_BADGE;
}

/* ========= MAIN ========= */

async function main() {
  const raw = await fs.readFile(DATA_PATH, "utf-8");
  const json = JSON.parse(raw);

  const badgeIndex = await buildBadgeIndex();
  const ymd = getArgentinaYmd();

  for (const lg of json.leagues) {
    const code = ESPN_LEAGUE[lg.id];
    if (!code) continue;

    const sb = await fetchScoreboard(code, ymd);
    const events = sb.events ?? [];
    const fixture = [];

    for (const ev of events) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;

      const home = comp.competitors.find(c => c.homeAway === "home");
      const away = comp.competitors.find(c => c.homeAway === "away");

      const argIso = toArgentinaISO(comp.date);
      const homeName = home.team.displayName;
      const awayName = away.team.displayName;

      fixture.push({
        league: lg.name,
        dateISO: argIso,
        dateText: formatDateText(argIso),
        home: { name: homeName, badge: pickLocalBadge(badgeIndex, homeName) },
        away: { name: awayName, badge: pickLocalBadge(badgeIndex, awayName) },
        footer: footer(comp)
      });
    }

    lg.fixture = fixture;
  }

  await fs.writeFile(DATA_PATH, JSON.stringify(json, null, 2));
  console.log("data.json actualizado con escudos locales");
}

main();
