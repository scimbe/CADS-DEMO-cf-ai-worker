# How-to: KI-Fallback (LightLLM) konfigurieren — Text & Sprache

Cloudflare Workers AI hat ein Tageskontingent (kostenlos: 10.000 Neuronen/Tag). Ist es aufgebraucht, schlagen LLM-Aufrufe mit Fehler `4006` fehl. Dieses Projekt kann dann automatisch auf einen selbstgehosteten LightLLM-Proxy (Modell `local-devstral-small2`, unterstützt Function-Calling) ausweichen.

## Funktionsweise

- **Modus "Automatisch" (Standard):** Jeder Turn beginnt mit Workers AI. Kommt der allererste Stream-Part als Fehler zurück (z.B. Kontingent aufgebraucht), wird der komplette Turn stattdessen über LightLLM abgewickelt. Ein Fehler mitten im Turn (nach bereits gesprochenem Text) löst **keinen** Wechsel aus - das würde abgeschnittene/doppelte Sätze riskieren.
- **Manuell erzwingen:** Admin-Panel (`/admin.html`) → "KI-Anbieter" → Cloudflare Workers AI oder LightLLM fest wählen, unabhängig vom Kontingentstatus. Nützlich zum Testen oder wenn man bewusst nur eine Quelle nutzen will.

## Einrichtung

1. `.dev.vars` ergänzen:
   ```
   LIGHTLLM_API_KEY=sk-...
   ```
2. `wrangler.jsonc` → `vars.LIGHTLLM_BASE_URL` auf die OpenAI-kompatible Basis-URL setzen (z.B. `https://<host>/v1`).
3. Für Produktion: `wrangler secret put LIGHTLLM_API_KEY`.

## Spracherkennung (STT): manuell, nicht automatisch

Cloudflares STT (Deepgram Flux) hängt am selben Tageskontingent — ist es aufgebraucht, scheitert auch ein echter Sprachanruf, selbst wenn der LLM-Fallback funktioniert. Dagegen gibt es ebenfalls eine Alternative über LLM2s `speech_to_text`-Channel, aber **kein automatischer Wechsel**: derselbe Admin-Schalter steuert beides, aber für STT gibt es keine zuverlässige Möglichkeit, einen Ausfall synchron zu erkennen, bevor ein Anruf beginnt. Bei Cloudflare-Ausfall im Admin-Panel manuell auf "LightLLM" stellen.

**Wichtige Einschränkung:** LLM2s `speech_to_text` ist reines Request/Response (kompletter Audio-Clip rein, Transkript raus) — kein Streaming, kein serverseitiges Turn-Erkennen wie bei Flux. Deshalb übernimmt `src/lib/lightllm-stt.ts` selbst eine einfache energiebasierte Sprechpausen-Erkennung (RMS-Schwellenwert) und schickt erst nach erkannter Pause einen ganzen Clip los. Das bedeutet spürbare Verzögerung pro Gesprächsrunde (Upload + Fetch + Whisper-Inferenz) und **kein Barge-in** (man kann Lea nicht unterbrechen). Ein echtes Streaming-Feature ist als [ct-agent-Issue #220](https://github.com/scimbe/ct-agent/issues/220) eingeplant, aber ohne Zeitplan.

Der Clip wird dafür kurz über die eigene, bereits öffentlich erreichbare Tunnel-URL bereitgestellt (`GET .../stt-audio/:id`, einmal abrufbar, danach gelöscht) — LLM2s Handler lädt Audio nur per HTTPS-URL, kein Inline-Upload möglich. Dafür ist `PUBLIC_BASE_URL` (in `wrangler.jsonc`) auf die tatsächliche öffentliche Basis-URL des Agenten zu setzen.

## Grenzen

- Andere Backends (z.B. reine `text_generation`-Channel-Dienste ohne Tool-Calling) eignen sich **nicht** als Ersatz für die Terminbuchung, da die Buchungslogik zwingend Function-Calling braucht - nur als reiner Text-Fallback ohne Buchungsfähigkeit.
- Kleinere Modelle (z.B. 7B-Klasse) können bei komplexeren Anfragen ungenauer formulieren als das primäre 70B-Modell - funktional (inkl. Tool-Calling), aber sprachlich nicht ganz gleichwertig.
- STT (Spracherkennung) und die selbstgehostete TTS-Stimme (siehe [Thorsten-Stimme anbinden](./thorsten-stimme-anbinden.md)) sind von diesem Fallback unabhängig - er deckt nur den LLM-Teil (Textverständnis + Terminlogik) ab, nicht die Sprach-Ein-/Ausgabe.

## Debugging

`scripts/debug-stream.mjs` ruft den Workers-AI-Stream isoliert auf (ohne Voice-Pipeline) - nützlich, um Provider-Probleme von Pipeline-Problemen zu unterscheiden. `scripts/ws-text-test.mjs` schickt eine Text-Nachricht direkt per WebSocket an den laufenden Dev-Server (umgeht Mikrofon/STT, testet nur LLM+Tools+TTS-Trigger).
