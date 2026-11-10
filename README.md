# MCP Media Generator + Video Merger Service

> Serveur MCP pour la génération d'images et de vidéos par IA (kie.ai + CometAPI avec bascule automatique multi-clés) + service de fusion vidéo, avec tableaux de bord d'administration en arabe (RTL).

## Structure du dépôt

| Dossier | Projet | Stack |
|---|---|---|
| `/` (racine) | **MCP Media Generator** — serveur MCP sur `/mcp` + dashboard arabe + API de gestion des clés | Next.js 16 (App Router) + TypeScript + Tailwind + `@modelcontextprotocol/sdk` + `@libsql/client` (Turso) |
| `/merger` | **Video Merger API v2** — site de fusion vidéo + API publique (sans auth, CORS ouvert) | Node.js pur (CommonJS) + Turso (blobs) + `ffmpeg-static`/`ffprobe-static` |

## Les 5 outils MCP (sur `<origin>/mcp`)

1. `generate_image` — image via `gpt-image-2-6/flare-text-to-image`
2. `generate_video` — vidéo via `grok-imagine-video-1-5-preview` (audio natif synchronisé)
3. `merge_videos` — fusion de 2 à 10 clips (`urls` ou `task_ids`) en une vidéo finale
4. `get_task` — suivi de toute tâche par son id
5. `list_media` — dernières médias stockés avec leurs liens

Règles d'or implémentées :
- **Liens uniquement** — aucun média n'est téléchargé sur le serveur.
- **Ordre strict des clés** (`created_at ASC, id ASC`) — pas de round-robin ; les clés épuisées restent en base, seule la désactivation manuelle les exclut.
- **Bascule « zéro arrêt »** : la même tâche (même `task_id`) reprend sur la clé suivante en cas d'erreur de clé/solde — le modèle ne voit jamais ces erreurs.
- Tâche échouée sur toutes les clés → reste `processing`, réessayée à chaque `get_task` (repos ~45 s).
- Erreurs HTTP du service de fusion = échec final ; erreurs réseau = temporaires.
- Fichiers de fusion supprimés après 24 h (avertissement inclus dans les réponses).
- Clés toujours masquées (`maskKey`) dans toutes les réponses et journaux.

## Exécution locale

### 1) MCP Media Generator (racine)

```bash
bun install   # ou npm install
# .env.local :
#   TURSO_DATABASE_URL=libsql://<db>.turso.io
#   TURSO_AUTH_TOKEN=<jeton Turso>
#   MERGER_API_BASE=http://localhost:3001
bun run dev   # http://localhost:3000
```

- Dashboard : http://localhost:3000 (arabe RTL — clés, tâches, connexion)
- Santé : http://localhost:3000/api/health
- MCP : http://localhost:3000/mcp

### 2) Service de fusion (`merger/`)

```bash
cd merger
bun install
# .env :
#   TURSO_DATABASE_URL=libsql://<db>.turso.io
#   TURSO_AUTH_TOKEN=<jeton Turso>
node server.js   # http://localhost:3001 (simule Vercel : .env chargé manuellement, routes dynamiques → req.query)
```

- Interface : http://localhost:3001 (arabe RTL, thème sombre cyan/violet)
- Test de fusion :
  ```bash
  curl -X POST http://localhost:3001/api/jobs -H 'Content-Type: application/json' \
    -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
  curl -X POST http://localhost:3001/api/jobs/<jobId>/process   # synchrone ~10-15 s
  curl -o merged.mp4 "http://localhost:3001/api/jobs/<jobId>/video?download=1"
  ```

## Déploiement Vercel (2 projets)

### Projet A — Video Merger (`/merger`)

1. Importer le dépôt → **Root Directory : `merger`**.
2. Variables d'environnement : `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
3. Déployer. Un cron quotidien (`/api/cron`) purge les jobs expirés (>24 h).
4. Noter l'URL (ex. `https://merger-xxx.vercel.app`).

### Projet B — MCP Media Generator (racine)

1. Importer le dépôt → **Root Directory : `/`** (racine).
2. Variables d'environnement :
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
   - `MERGER_API_BASE=https://merger-xxx.vercel.app` (URL du projet A)
   - Optionnel : `MCP_ACCESS_TOKEN` (si défini, `Authorization: Bearer` exigé sur `/mcp`), `KIE_IMAGE_MODEL`, `KIE_VIDEO_MODEL`, `COMETAPI_IMAGE_MODEL`, `COMETAPI_VIDEO_MODEL`
3. Déployer. Ajouter ensuite les clés API (kie.ai / CometAPI) depuis le dashboard → carte « إدارة المفاتيح ».

> Note : les binaires `ffmpeg-static`/`ffprobe-static` (~110 Mo) dépassent la limite de fonction serverless du plan Hobby (50 Mo) — le projet A nécessite un plan Vercel **Pro** (ou un hébergement alternatif type Railway/Render). Le projet B fonctionne sur Hobby.

## Connexion des clients MCP

```json
{ "mcpServers": { "media-generator": { "url": "https://<votre-app>.vercel.app/mcp" } } }
```

- **ChatGPT** : Settings → Connectors → Create → Custom MCP server → Server URL.
- **Claude Desktop** : `claude_desktop_config.json` avec `"type": "http"`.
- **Cursor / Windsurf / Cline** : `mcp.json` au même format.

La vidéo prend des minutes : le serveur renvoie immédiatement un `task_id` et le suivi se fait via `get_task` toutes les ~10 s, avec notifications de progression live.
