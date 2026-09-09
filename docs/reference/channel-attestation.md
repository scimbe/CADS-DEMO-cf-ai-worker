# Reference: ct-agent Channel-Attestation

Um einem "registered channel" (feste, vom Owner vergebene `channel_id`, kein Pairwise-Link) als Mitglied beizutreten, ist eine Ed25519-Signatur über eine feste 122-Byte-Nachricht nötig. Es gibt keinen fertigen `ct-agent`-CLI-Befehl dafür (weder `channel member-material` [nur Pairwise] noch `channel join-pipeline-role` [nur Pipeline-Rollen] passen) — die Signatur muss manuell erzeugt werden.

Quellcode-verifiziert gegen `ct_common::channel::member_noise_attest_bytes` (`crates/common/src/channel.rs` + `crates/common/src/preimage.rs`).

## Byte-Layout (exakt 122 Byte)

```
[0x16, 0x00, 0x00, 0x00]   4 Byte, u32 little-endian = 22 (Länge des Domain-Strings)
"ct-a2a-noise-attest-v1"   22 Byte, ASCII, kein Null-Terminator
channel_id                 32 Byte, roh
holder_pubkey               32 Byte, roh
noise_pubkey                 32 Byte, roh
```
Reine Byte-Konkatenation, keine bincode/borsh-Hülle. Signiert wird PureEdDSA (RFC 8032) über exakt diese 122 Bytes — kein Pre-Hash.

## Ablauf

1. `ct-agent channel init` → liefert `holder_pubkey`/`noise_pubkey` (öffentlich, an den Channel-Owner schicken) und die privaten Gegenstücke (geheim halten).
2. Channel-Owner liefert die `channel_id` und einen `CT_CHANNEL_GRANT` (signiert, zeitlich begrenzt).
3. Mit dem eigenen `holder_key` die 122-Byte-Nachricht signieren (siehe Python-Referenz unten).
4. Das Tripel `(holder_pubkey, noise_pubkey, signature)` an den Channel-Owner schicken — der trägt es serverseitig in den Mitglieder-Roster ein.

## Python-Referenz (PyNaCl)

```python
import struct
from nacl.signing import SigningKey

def member_noise_attest_bytes(channel_id_hex, holder_pubkey_hex, noise_pubkey_hex):
    domain = b"ct-a2a-noise-attest-v1"
    return (
        struct.pack("<I", len(domain))
        + domain
        + bytes.fromhex(channel_id_hex)
        + bytes.fromhex(holder_pubkey_hex)
        + bytes.fromhex(noise_pubkey_hex)
    )

signing_key = SigningKey(bytes.fromhex(HOLDER_PRIVATE_KEY_HEX))
msg = member_noise_attest_bytes(CHANNEL_ID_HEX, HOLDER_PUBKEY_HEX, NOISE_PUBKEY_HEX)
assert len(msg) == 122  # Sanity-Check vor dem Signieren
signature_hex = signing_key.sign(msg).signature.hex()
```

## UDP/QUIC blockiert? Front-Door-Fallback

Admission (Broker) und Relay sind standardmäßig QUIC/UDP, unabhängig von `CT_CHANNEL_RELAY_ONLY` (das steuert nur Relay- vs. Direct-Modus, nicht das Transportprotokoll). Ist UDP blockiert (z.B. restriktive Sandbox), zusätzlich setzen:

```
CT_CHANNEL_FRONT_DOOR=<host>:443
CT_CHANNEL_FRONT_DOOR_ONLY=1
CT_CHANNEL_FRONT_DOOR_CERT=<hex-kodiertes CA-Zertifikat von https://<host>/pki/ca>
```

Ohne `CT_CHANNEL_FRONT_DOOR_ONLY=1` probiert `ct-agent` zuerst den (dann aussichtslosen) QUIC-Weg und fällt erst danach zurück — mit dem Schalter wird das übersprungen.

## Latenz: Prozess wiederverwenden statt neu starten

Ein voller Verbindungsaufbau (Noise-Handshake + Admission) dauert mehrere Sekunden. `ct-agent channel` verarbeitet mehrere Anfragen nacheinander über **einen** persistenten Prozess (zeilenweises JSON auf stdin/stdout) — siehe `audio-bridge/server.mjs`. Das senkt die Latenz pro Anfrage von ~5s auf ~0,2s. Die Verbindung kann nach längerer Nutzung mit "early eof" abbrechen; `ct-agent` verbindet sich dann selbst neu, aber eine Anfrage kann in das kurze Reconnect-Fenster fallen — die Bridge wiederholt eine fehlgeschlagene Anfrage deshalb einmal automatisch.
