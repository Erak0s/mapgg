import express from "express";
import cors from "cors";
import Database from "better-sqlite3";

const app = express();
app.use(cors({
  origin: [
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "null",
    null,
    "https://mapgg.netlify.app"
  ]
}));
app.use(express.json());

const STARTGG_API_KEY = "4084825f7edcee7e793552fbf5f46648";
const STARTGG_ENDPOINT = "https://api.start.gg/gql/alpha";

// ── Geocoding cache (SQLite) ──────────────────────────────────────────────
const db = new Database("geocache.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS geocache (
    key     TEXT PRIMARY KEY,
    lat     REAL,
    lng     REAL
  )
`);
const stmtGet = db.prepare("SELECT lat, lng FROM geocache WHERE key = ?");
const stmtSet = db.prepare("INSERT OR REPLACE INTO geocache (key, lat, lng) VALUES (?, ?, ?)");

async function geocodeCity(city, country) {
  const key = `${city}||${country}`;

  // 1. Check SQLite cache first (synchronous, instant)
  const cached = stmtGet.get(key);
  if (cached) return cached.lat !== null ? { lat: cached.lat, lng: cached.lng } : null;

  // 2. Not in cache — call Nominatim
  try {
    const query = encodeURIComponent(`${city}, ${country}`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "mapgg-tournament-map/1.0" }
    });
    const data = await res.json();
    if (data && data[0]) {
      const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      stmtSet.run(key, coords.lat, coords.lng);
      return coords;
    }
  } catch (e) {
    console.warn(`Geocode failed for ${city}, ${country}:`, e.message);
  }

  // Store null result to avoid re-querying unknown cities
  stmtSet.run(key, null, null);
  return null;
}

async function graphql(query, variables = {}) {
  const res = await fetch(STARTGG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${STARTGG_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`start.gg HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

const GET_USER = `
  query GetUser($slug: String!) {
    user(slug: $slug) {
      id
      name
      slug
      images { url type }
      player { gamerTag }
    }
  }
`;

const GET_TOURNAMENTS = `
  query GetUserTournaments($userId: ID!, $page: Int!) {
    user(id: $userId) {
      tournaments(query: {
        page: $page
        perPage: 500
        filter: { }
      }) {
        pageInfo { total totalPages }
        nodes {
          id
          name
          slug
          startAt
          isOnline
          city
          countryCode
          lat
          lng
          images { url type }
        }
      }
    }
  }
`;

const GET_ADMIN_TOURNAMENTS = `
  query GetAdminTournaments($userId: ID!, $page: Int!) {
    user(id: $userId) {
      tournaments(query: {
        page: $page
        perPage: 50
        filter: { past: true, tournamentView: "admin" }
      }) {
        pageInfo { total totalPages }
        nodes {
          id
          name
          slug
          startAt
          isOnline
          city
          countryCode
          lat
          lng
          images { url type }
        }
      }
    }
  }
`;

const GET_TOURNAMENT_PARTICIPANTS = `
  query GetTournamentParticipants($slug: String!, $page: Int!) {
    tournament(slug: $slug) {
      id
      name
      slug
      startAt
      city
      countryCode
      lat
      lng
      images { url type }
      participants(query: { page: $page, perPage: 500 }) {
        pageInfo { total totalPages }
        nodes {
          user {
            name
            player { gamerTag }
            location {
              city
              country
              countryId
            }
          }
        }
      }
    }
  }
`;

const GET_USER_EVENTS = `
  query GetUserEvents($userId: ID!, $page: Int!) {
    user(id: $userId) {
      events(query: {
        page: $page
        perPage: 50
      }) {
        pageInfo { totalPages }
        nodes {
          tournament { id }
          videogame { name images { url type } }
        }
      }
    }
  }
`;

app.get("/api/player/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    const data = await graphql(GET_USER, { slug });
    if (!data.user) return res.status(404).json({ error: "Utilisateur introuvable" });
    data.user.displayName = data.user.player?.gamerTag || data.user.name || data.user.slug;
    res.json(data.user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tournaments/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;

    let allTournaments = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const data = await graphql(GET_TOURNAMENTS, { userId, page });
      const t = data.user?.tournaments;
      if (!t) break;
      totalPages = t.pageInfo.totalPages;
      allTournaments = allTournaments.concat(t.nodes || []);
      page++;
      await new Promise(r => setTimeout(r, 200));
    }

    const eventsByTournament = new Map();
    page = 1;
    totalPages = 1;
    while (page <= totalPages) {
      const data = await graphql(GET_USER_EVENTS, { userId, page });
      const e = data.user?.events;
      if (!e) break;
      totalPages = e.pageInfo.totalPages;
      for (const event of (e.nodes || [])) {
        const tid = event.tournament?.id;
        if (!tid || !event.videogame) continue;
        if (!eventsByTournament.has(tid)) eventsByTournament.set(tid, new Map());
        const games = eventsByTournament.get(tid);
        if (!games.has(event.videogame.name)) {
          games.set(event.videogame.name, event.videogame);
        }
      }
      page++;
      await new Promise(r => setTimeout(r, 200));
    }

    const offline = allTournaments
      .filter(t => !t.isOnline && t.lat != null && t.lng != null)
      .map(t => {
        t.userGames = [...(eventsByTournament.get(t.id)?.values() || [])];
        return t;
      });

    let adminTournaments = [];
    page = 1;
    totalPages = 1;
    while (page <= totalPages) {
      const data = await graphql(GET_ADMIN_TOURNAMENTS, { userId, page });
      const t = data.user?.tournaments;
      if (!t) break;
      totalPages = t.pageInfo.totalPages;
      adminTournaments = adminTournaments.concat(t.nodes || []);
      page++;
      await new Promise(r => setTimeout(r, 200));
    }

    const adminOffline = adminTournaments
      .filter(t => !t.isOnline && t.lat != null && t.lng != null)
      .map(t => ({ ...t, isAdmin: true, userGames: [] }));

    const adminIds = new Set(adminOffline.map(t => t.id));
    const mergedTournaments = [
      ...offline.map(t => ({ ...t, isAdmin: adminIds.has(t.id), isPlayer: true })),
      ...adminOffline.filter(t => !offline.find(o => o.id === t.id)).map(t => ({ ...t, isPlayer: false })),
    ];

    res.json({
      total: allTournaments.length,
      offline: offline.length,
      adminOffline: adminOffline.length,
      tournaments: mergedTournaments,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tournament/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    let page = 1;
    let totalPages = 1;
    let tournamentInfo = null;
    const locationMap = new Map();

    while (page <= totalPages) {
      const data = await graphql(GET_TOURNAMENT_PARTICIPANTS, { slug, page });
      const t = data.tournament;
      if (!t) return res.status(404).json({ error: "Tournoi introuvable" });

      if (!tournamentInfo) {
        tournamentInfo = {
          id: t.id,
          name: t.name,
          slug: t.slug,
          startAt: t.startAt,
          city: t.city,
          countryCode: t.countryCode,
          lat: t.lat,
          lng: t.lng,
          images: t.images,
          total: t.participants.pageInfo.total,
        };
      }

      totalPages = t.participants.pageInfo.totalPages;

      for (const p of (t.participants.nodes || [])) {
        const loc = p.user?.location;
        if (!loc?.city || !loc?.country) continue;
        const key = `${loc.city}||${loc.country}||${loc.countryId || ""}`;
        if (!locationMap.has(key)) {
          locationMap.set(key, {
            city: loc.city,
            country: loc.country,
            countryId: loc.countryId || "",
            count: 0,
            names: [],
          });
        }
        const entry = locationMap.get(key);
        entry.count++;
        const tag = p.user?.player?.gamerTag || p.user?.name;
        if (tag) entry.names.push(tag);
      }

      page++;
      await new Promise(r => setTimeout(r, 200));
    }

    // ── Geocode all unique cities ─────────────────────────────────────────
    const locations = [];
    for (const loc of locationMap.values()) {
      // Rate-limit Nominatim: 1 req/s
      await new Promise(r => setTimeout(r, 1100));
      const coords = await geocodeCity(loc.city, loc.country);
      if (!coords) continue; // skip cities that couldn't be geocoded
      locations.push({ ...loc, lat: coords.lat, lng: coords.lng });
    }

    res.json({ tournament: tournamentInfo, locations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Backend démarré sur http://localhost:${PORT}`));
