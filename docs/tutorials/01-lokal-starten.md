# Tutorial: Lokal starten

Ziel: Der Sprachassistent läuft lokal, du kannst per Browser einen Testanruf machen.

## Voraussetzungen

- Node.js 22+
- Ein Cloudflare-Account mit Workers-AI-Zugriff
- `wrangler login` einmal ausgeführt (oder ein API-Token mit `Workers Scripts: Edit` + `Workers AI: Edit`)

## Schritte

1. Abhängigkeiten installieren:
   ```bash
   npm install
   ```

2. Lokale Secrets anlegen:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   Trage ein eigenes `ADMIN_PASSWORD` ein. `AUDIO_BRIDGE_URL`/`AUDIO_BRIDGE_TOKEN` nur setzen, wenn du die selbstgehostete Stimme nutzt (siehe [How-to: Thorsten-Stimme anbinden](../how-to/thorsten-stimme-anbinden.md)) — ohne Bridge fällt die Sprachausgabe aus.

3. Dev-Server starten:
   ```bash
   npm run dev
   ```
   Öffnet einen lokalen Worker auf `http://localhost:8787` (Port ggf. abweichend, siehe Terminal-Ausgabe).

4. Browser öffnen, auf "📞 Anruf starten" klicken, Mikrofonzugriff erlauben, mit "Lea" sprechen.

## Nächste Schritte

- [Reference: Architektur](../reference/architektur.md) für den Gesamtüberblick
- [How-to: Öffentlich erreichbar machen](../how-to/oeffentlich-erreichbar-machen.md) um die Demo mit anderen zu teilen
