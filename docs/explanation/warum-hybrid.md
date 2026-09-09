# Explanation: Warum hybrid statt "alles Cloudflare"?

Ein Cloudflare Worker allein ist absichtlich eingeschränkt: keine langlebigen TCP/UDP-Verbindungen, kein Ausführen eigener Binaries, keine beliebigen Prozesse. Das macht Worker schnell, günstig und global verteilt — aber es bedeutet auch, dass manche Dinge dort grundsätzlich nicht gehen.

Dieses Projekt trifft die Entscheidung bewusst pro Baustein, nicht pauschal:

- **Voice-Pipeline, Kalenderlogik, HTTP/WebSocket-Routing** → Cloudflare. Genau dafür sind Worker/Durable Objects gebaut: viele kurze, verteilte Anfragen, kein eigener Server zu warten.
- **Deutsche TTS-Stimme, LLM-Fallback** → selbstgehostet. Cloudflare bietet das (noch) nicht in der gewünschten Qualität bzw. hat ein begrenztes Gratis-Kontingent. Eigene Infrastruktur füllt genau diese Lücke.
- **Verbindung dazwischen** → ein bewusst kleiner, ausgetauschter Vertrag: HTTP rein, HTTP/URL raus. Der Worker weiß nichts vom Noise-Protokoll, den Broker-Grants oder dem Channel-Mesh dahinter — das ist vollständig hinter dem Bridge-Dienst versteckt.

## Die Kernlektion

Die Grenze zwischen "läuft im Worker" und "läuft woanders" folgt nicht der Frage "was ist bequemer", sondern **"was kann eine Worker-Isolate technisch überhaupt"** (kein UDP/QUIC, keine Subprozesse) und **"wo gibt es bereits eine bessere Lösung"** (eine trainierte deutsche Stimme, ein Modell mit Tool-Calling ohne Tageslimit). Ein sauberer HTTP-Vertrag an der Grenze hält beide Seiten unabhängig austauschbar — die selbstgehosteten Dienste wissen nichts vom Worker, der Worker kennt nur "POST Text rein, URL/Antwort raus".

Das Ergebnis ist kein Kompromiss zwischen zwei Welten, sondern nutzt in jeder Welt das, was sie am besten kann.
