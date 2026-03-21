import express from "express";
import cors from "cors";

const app = express();
app.use(cors({
  origin: [
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "null",
    null,
    "https://TON-SITE.netlify.app"
  ]
}));
app.use(express.json());

const STARTGG_API_KEY = "4084825f7edcee7e793552fbf5f46648";
const STARTGG_ENDPOINT = "https://api.start.gg/gql/alpha";

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

// Récupère l'userId depuis le slug (ex: "user/abc123" ou juste "abc123")
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

// Récupère tous les tournois d'un utilisateur avec pagination
const GET_TOURNAMENTS = `
  query GetUserTournaments($userId: ID!, $page: Int!) {
    user(id: $userId) {
      tournaments(query: {
        page: $page
        perPage: 50
        filter: { past: true }
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

    // 1. Récupère tous les tournois
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
      if (page > 10) break;
    }

    // 2. Récupère tous les events de l'utilisateur
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
      if (page > 20) break;
    }

    // 3. Filtre offline + associe les jeux
    const offline = allTournaments
      .filter(t => !t.isOnline && t.lat != null && t.lng != null)
      .map(t => {
        t.userGames = [...(eventsByTournament.get(t.id)?.values() || [])];
        return t;
      });

    res.json({ total: allTournaments.length, offline: offline.length, tournaments: offline });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Backend démarré sur http://localhost:${PORT}`));