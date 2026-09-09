# Reference: Architektur

## Komponenten

| Komponente | Datei/Pfad | Zweck |
|---|---|---|
| `SalonAgent` | `src/agents/salon-agent.ts` | Durable Object: Voice-Pipeline, Terminlogik, Admin-API |
| Kalenderlogik | `src/lib/calendar.ts` | Reine Funktionen: Slots, Kollisionen, Zeitzonen (Europe/Berlin) |
| Systemprompt | `src/lib/prompt.ts` | Persona "Lea", Öffnungszeiten, Leistungen |
| TTS-Provider | `src/lib/ctagent-tts.ts` | Ruft den externen `audio-bridge`-Dienst auf |
| Worker-Einstieg | `src/server.ts` | Routing via `routeAgentRequest` |
| Client-Voice-Widget | `src/client/voice-widget.ts` | `VoiceClient` aus `@cloudflare/voice/client` |
| Bridge-Dienst | `audio-bridge/server.mjs` | HTTP ↔ ct-agent-Channel-Übersetzer (separater Prozess) |
| LLM-Fallback | `src/agents/salon-agent.ts` (`streamFromProvider`, `onTurn`) | Wechselt bei Workers-AI-Fehlern automatisch zu LightLLM (Devstral) |

## Datenmodell (Durable-Object-SQLite)

- `appointments(id, customer_name, phone, service, start_ts, end_ts, status, notes, created_at)`
- `blockers(id, start_ts, end_ts, reason, created_at)`
- `admin_sessions(token, expires_at)`
- `settings(key, value)` — u.a. `llm_provider` (`auto`|`workers-ai`|`lightllm`), per Admin-Panel gesetzt

Alle Zeitstempel: Unix-Millisekunden (UTC), Anzeige/Eingabe in `Europe/Berlin`.

## HTTP-Endpunkte

Alle unter `/agents/salon-agent/default/...` (siehe [agents-Routing](https://developers.cloudflare.com/agents/)):

| Route | Methode | Zweck |
|---|---|---|
| `/availability` | GET | Öffentlich, keine Auth: Verfügbarkeitsübersicht |
| `/admin/login` | POST | Admin-Passwort → Bearer-Token |
| `/admin/appointments` | GET/DELETE | Termine einsehen/stornieren (Auth) |
| `/admin/blockers` | GET/POST/DELETE | Blocker verwalten (Auth) |
| `/admin/settings` | GET/POST | KI-Anbieter auslesen/erzwingen (Auth) |

Voice-WebSocket läuft ebenfalls über `/agents/salon-agent/default` (Protokoll-Upgrade, von `@cloudflare/voice` verwaltet).

## Sprachmodelle

- LLM primär: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Function-Calling, mehrsprachig)
- LLM-Fallback: LightLLM-Proxy, Modell `local-devstral-small2` (OpenAI-kompatibel, Function-Calling) — siehe [How-to: LLM-Fallback konfigurieren](../how-to/llm-fallback-konfigurieren.md)
- STT: Deepgram Flux (`WorkersAIFluxSTT`)
- TTS: selbstgehostetes Piper/Thorsten (siehe [Channel-Attestation](./channel-attestation.md))

## Bekannte Provider-Eigenheiten

- `workers-ai-provider` liefert aktuell jedes `text-delta`-Chunk zweimal identisch hintereinander (verifiziert via `scripts/debug-stream.mjs`, unabhängig von der Voice-Pipeline). `dedupeConsecutiveTextDeltas()` in `salon-agent.ts` filtert das heraus.
- Cloudflare Workers AI hat ein kostenloses Tageskontingent (10.000 Neuronen). Bei Erschöpfung: Fehler `4006`, STT-WebSocket-Verbindungen schlagen ebenfalls fehl. Der Frontend-Client zeigt dafür eine verständliche deutsche Fehlermeldung (`#call-error` in `voice-widget.ts`).
