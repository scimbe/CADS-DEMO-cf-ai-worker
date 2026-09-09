# How-to: Selbstgehostete Thorsten-Stimme anbinden

Cloudflare Workers AI hat keine überzeugende deutsche TTS-Stimme (Deepgram Aura nur Englisch/Spanisch, MeloTTS ohne offizielle Deutsch-Unterstützung). Dieses Projekt nutzt stattdessen eine selbstgehostete Piper-Instanz mit der Stimme "Thorsten", angebunden über ein privates [ct-agent](https://github.com/scimbe/ct-agent)-Mesh.

## Warum nicht direkt aus dem Worker?

Ein Cloudflare Worker/Durable Object kann kein UDP/QUIC und führt keine eigenen Binaries aus — das ct-agent-Channel-Protokoll (Noise-verschlüsselt, Marketplace-Broker) lässt sich also nicht direkt aus der Isolate heraus sprechen. Die Lösung: ein kleiner, separat laufender **Bridge-Dienst** (`audio-bridge/`), der:

1. Text per HTTP entgegennimmt,
2. ihn über `ct-agent channel` an den `audio_generation`-Channel weiterreicht,
3. die resultierende Audio-URL per HTTP zurückgibt.

Der Worker ruft nur noch ganz normal `fetch()` auf — zweimal: einmal die Bridge, einmal die fertige Audiodatei.

## Voraussetzungen

- Ein laufender `ct-agent` (Binary von [scimbe/ct-agent Releases](https://github.com/scimbe/ct-agent/releases))
- Mitgliedschaft im Ziel-Channel (Attestation + Roster-Eintrag durch den Channel-Owner — siehe [Reference: Channel-Attestation](../reference/channel-attestation.md))
- Node.js für den Bridge-Dienst

## Schritte

1. Channel-Identität erzeugen:
   ```bash
   ct-agent channel init
   ```
   Die beiden **Public Keys** an den Channel-Owner schicken, die Attestation gemäß [Reference: Channel-Attestation](../reference/channel-attestation.md) signieren und ebenfalls schicken.

2. `audio-bridge/.env` anlegen (Beispiel):
   ```bash
   BRIDGE_PORT=58090
   BRIDGE_AUTH_TOKEN=<zufälliges Token, teilst du mit dem Worker>
   CT_AGENT_BIN=/pfad/zu/ct-agent

   CT_CHANNEL_ROLE=initiate
   CT_CHANNEL_BROKER=<broker-host>:4435
   CT_CHANNEL_RELAY=<broker-host>:4436
   CT_CHANNEL_RELAY_ONLY=1
   # Nur nötig, wenn UDP/QUIC blockiert ist (z.B. restriktive Sandbox/Firewall):
   CT_CHANNEL_FRONT_DOOR=<broker-host>:443
   CT_CHANNEL_FRONT_DOOR_ONLY=1
   CT_CHANNEL_FRONT_DOOR_CERT=<hex-kodiertes CA-Zertifikat, von https://<broker-host>/pki/ca>
   CT_CHANNEL_ID=<vom Channel-Owner>
   CT_CHANNEL_HOLDER_KEY=<aus channel init>
   CT_CHANNEL_NOISE_KEY=<aus channel init>
   CT_CHANNEL_GRANT=<vom Channel-Owner ausgestellt>
   ```

3. Bridge starten:
   ```bash
   cd audio-bridge
   set -a; source ./.env; set +a
   node server.mjs
   ```

4. Testen:
   ```bash
   curl -X POST http://localhost:58090/synthesize \
     -H "Authorization: Bearer $BRIDGE_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"text":"Hallo Test","voice":"primary"}'
   ```
   Erwartete Antwort: `{"url":"https://.../audio/<id>.wav"}`

5. Im Worker `AUDIO_BRIDGE_URL` (z.B. `http://127.0.0.1:58090`) und `AUDIO_BRIDGE_TOKEN` setzen (`.dev.vars` lokal, `wrangler secret put` für Produktion).

## Troubleshooting

- **`admission attempt N error, retrying: timed out`**: UDP/QUIC ist blockiert. `CT_CHANNEL_FRONT_DOOR*` setzen (Schritt 2).
- **`invalid peer certificate: BadEncoding`**: Zertifikat-Hex frisch von `/pki/ca` ziehen statt manuell kopieren — leicht zu vertippen.
- **Leere Antwort vom Channel-Call**: meist fehlende Channel-Mitgliedschaft (Roster-Eintrag) oder abgelaufener/falscher `CT_CHANNEL_GRANT`.
