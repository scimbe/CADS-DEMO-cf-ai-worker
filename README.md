# CADS-DEMO-cf-ai-worker

Ein KI-Sprachassistent für Friseur-Terminbuchung auf einem Cloudflare Worker — und ein Beispiel für ein **hybrides Setup**: Cloudflare übernimmt Edge-Compute, Voice-Pipeline und Kalenderlogik, während die Sprachausgabe über einen **selbstgehosteten Dienst** (Piper/Thorsten-TTS) läuft, erreichbar über ein privates [ct-agent](https://github.com/scimbe/ct-agent)-Mesh statt über eine weitere Cloud-API.

## Der eigentliche Mehrwert: Worker + eigene Dienste kombiniert

Die meisten Cloudflare-Worker-Demos bleiben komplett innerhalb der Cloudflare-Plattform. Dieses Projekt zeigt bewusst das Gegenteil: **wie weit man mit einem Worker kommt, wenn man ihn mit selbstgehosteter Infrastruktur kombiniert**, ohne die Vorteile beider Seiten aufzugeben.

| Baustein | Läuft auf | Warum dort |
|---|---|---|
| Voice-Pipeline (STT, Gesprächslogik, Sentence-Chunking) | Cloudflare (`@cloudflare/voice`, Workers AI) | Globales Edge-Netz, keine eigene Infrastruktur für Sprach-Streaming nötig |
| Terminkalender & Buchungslogik | Cloudflare Durable Object (SQLite) | Strikt sequenzielle Verarbeitung macht Doppelbuchungen strukturell unmöglich, ganz ohne Locking |
| Deutsche TTS-Stimme (Thorsten/Piper) | Eigener Server, per ct-agent-Mesh-Channel | Cloudflare Workers AI hat aktuell keine gute deutsche Stimme — eine selbstgehostete Piper-Instanz schon, und bleibt trotzdem einfach anbindbar |
| Bridge-Dienst (`audio-bridge`) | Kleiner Dauerprozess außerhalb des Workers | Ein Worker/Durable Object kann kein QUIC/Noise-Protokoll sprechen (Sandbox-Limitierung) — der Bridge-Dienst übersetzt HTTP ↔ Mesh-Channel |
| LLM-Fallback (Devstral, Function-Calling) | Selbstgehosteter LightLLM-Proxy | Cloudflare Workers AI hat ein tägliches Gratis-Kontingent — bei Erschöpfung übernimmt automatisch (oder per Admin-Schalter erzwungen) ein zweites, ebenfalls tool-calling-fähiges Modell |

Das Ergebnis: Man muss sich nicht zwischen "alles Cloudflare" und "alles selbstgehostet" entscheiden. Man nimmt für jeden Baustein die Plattform, die dafür am besten passt, und verbindet beides über einfache, klar abgegrenzte Schnittstellen (HTTP + eine öffentliche Datei-URL für das Audioergebnis).

## Architektur

```
Browser (Mikrofon) ──WebSocket──▶ Cloudflare Worker / Durable Object (SalonAgent)
                                        │
                                        ├─▶ Workers AI: STT (Deepgram Flux) + LLM (Llama 3.3, Function-Calling)
                                        │
                                        └─▶ audio-bridge (eigener Server) ──ct-agent channel──▶ LLM2-Host
                                                                                                  │
                                                                                            Piper/Thorsten-TTS
                                                                                                  │
                                                                                     https://.../audio/<id>.wav
                                                                                                  │
                                        ◀─────────────────────── Worker holt WAV direkt per fetch() ┘
```

## Features

- Sprachgesteuerte Terminbuchung, -verschiebung und -absage per natürlichem Gespräch
- Öffentlicher Verfügbarkeitskalender auf der Landing-Page
- Admin-Bereich für Blocker (Urlaub/Pause) und Terminverwaltung
- Text-Fallback ohne Mikrofon
- Vollständig getestete Kalenderlogik (Öffnungszeiten, Kollisionen, Zeitzonen)

## Dokumentation

Siehe [`docs/`](./docs) — gegliedert nach [Diátaxis](https://diataxis.fr/): Tutorials, How-to-Anleitungen, Referenz, Hintergrundwissen.

## Schnellstart

```bash
npm install
cp .dev.vars.example .dev.vars   # eigenes Admin-Passwort + Bridge-Token eintragen
npm run dev
```

Details: [`docs/tutorials/01-lokal-starten.md`](./docs/tutorials/01-lokal-starten.md)

## Stack

Cloudflare Workers, Durable Objects, Workers AI, `@cloudflare/voice` (experimentell), Vercel AI SDK, TypeScript, Vitest.

---

Gebaut mit [Claude Code](https://claude.com/claude-code).
