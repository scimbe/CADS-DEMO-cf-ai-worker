import { VoiceClient } from "@cloudflare/voice/client";

function req<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Element ${selector} nicht gefunden`);
  return el;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "Bereit für Ihren Anruf",
  listening: "Ich höre zu …",
  thinking: "Einen Moment …",
  speaking: "Thomas spricht …"
};

function initVoiceWidget() {
  const callBtn = req<HTMLButtonElement>("#call-btn");
  const muteBtn = req<HTMLButtonElement>("#mute-btn");
  const statusEl = req<HTMLElement>("#status");
  const errorEl = req<HTMLElement>("#call-error");
  const transcriptEl = req<HTMLElement>("#transcript");
  const textForm = req<HTMLFormElement>("#text-form");
  const textInput = req<HTMLInputElement>("#text-input");

  const client = new VoiceClient({ agent: "salon-agent", name: "default" });

  const render = () => {
    statusEl.textContent = STATUS_LABEL[client.status] ?? client.status;
    statusEl.dataset.status = client.status;
    callBtn.textContent = client.status === "idle" ? "📞 Anruf starten" : "📴 Anruf beenden";
    muteBtn.disabled = client.status === "idle";
    muteBtn.textContent = client.isMuted ? "🔇 Stumm aufheben" : "🎤 Stummschalten";
  };

  const renderTranscript = () => {
    transcriptEl.innerHTML = "";
    for (const msg of client.transcript) {
      const p = document.createElement("p");
      p.className = `msg msg-${msg.role}`;
      p.textContent = msg.text;
      transcriptEl.appendChild(p);
    }
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  };

  client.addEventListener("statuschange", render);
  client.addEventListener("mutechange", render);
  client.addEventListener("transcriptchange", renderTranscript);
  // Der Server meldet nach Buchung/Absage/Verschiebung eine Aenderung: Seite soll die Uebersicht neu laden.
  client.addEventListener("custommessage", (msg: unknown) => {
    if ((msg as { type?: string } | null)?.type === "availability_changed") {
      window.dispatchEvent(new CustomEvent("availability-changed"));
    }
  });
  const friendlyError = (message: string): string => {
    if (/neuron|quota|kontingent|4006/i.test(message)) {
      return "Der Sprachassistent ist gerade ausgelastet (KI-Kontingent für heute aufgebraucht). Bitte versuchen Sie es später erneut.";
    }
    if (/websocket|failed to start|connection/i.test(message)) {
      return "Die Sprachverbindung konnte nicht aufgebaut werden. Bitte versuchen Sie es in ein paar Minuten erneut.";
    }
    return `Es ist ein Fehler aufgetreten: ${message}`;
  };

  client.addEventListener("error", (message) => {
    if (message) {
      errorEl.textContent = friendlyError(message);
      errorEl.hidden = false;
    } else {
      errorEl.hidden = true;
    }
  });

  client.connect();
  render();

  callBtn.addEventListener("click", async () => {
    if (client.status === "idle") {
      await client.startCall();
    } else {
      client.endCall();
    }
    render();
  });

  muteBtn.addEventListener("click", () => client.toggleMute());

  textForm.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();
    const text = textInput.value.trim();
    if (!text) return;
    client.sendText(text);
    textInput.value = "";
  });
}

document.addEventListener("DOMContentLoaded", initVoiceWidget);
