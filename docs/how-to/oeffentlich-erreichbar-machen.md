# How-to: Demo öffentlich erreichbar machen

## Option A: Echtes Deployment (empfohlen für Dauerbetrieb)

```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put AUDIO_BRIDGE_TOKEN
npm run deploy
```

Ergibt eine feste `https://<name>.<account>.workers.dev`-URL. Kein Tunnel nötig — ein deployter Worker läuft nativ im Cloudflare-Netz.

## Option B: Lokalen Dev-Server kurzzeitig freigeben

Für schnelles Testen ohne Deploy, z.B. mit dem offiziellen `cloudflared`:

```bash
npx wrangler dev --port 8787 &
cloudflared tunnel --url http://localhost:8787
```

Liefert eine temporäre `https://*.trycloudflare.com`-URL. Kein Account nötig, aber ohne Uptime-Garantie — nur für Live-Demos/Tests gedacht.

## Wichtig bei Voice-Agenten

Mikrofonzugriff (`getUserMedia`) verlangt einen sicheren Kontext (HTTPS oder `localhost`). Ein simples `http://<lokale-ip>:8787` von einem anderen Gerät aus funktioniert deshalb nicht — dafür Option A oder B nutzen.
