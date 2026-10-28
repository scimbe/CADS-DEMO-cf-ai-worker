import { Agent } from "agents";
import type { Connection } from "agents";
import { withVoice, WorkersAIFluxSTT, type VoiceTurnContext } from "@cloudflare/voice";
import { CtAgentBridgeTTS } from "../lib/ctagent-tts";
import { LightLlmSTT } from "../lib/lightllm-stt";
import { AutoFallbackSTT } from "../lib/auto-fallback-stt";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, generateText, tool, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import {
  SERVICE_KEYS,
  SERVICES,
  type ServiceKey,
  type Appointment,
  type Blocker,
  OPENING_HOURS,
  getAvailableSlots,
  isSlotFree,
  isWithinBookingHorizon,
  zonedTimeToUtcMs,
  toDateStr,
  toTimeStr,
  formatDateHumanDe,
  weekdayNameDe,
  weekdayOfDateStr,
  SLOT_STEP_MIN
} from "../lib/calendar";
import { buildSystemPrompt } from "../lib/prompt";
import { runTurnWithRepair, executeLeaked, type StreamOptions } from "../lib/turn-runner";
import { recoverTurn, renderToolOutput, parseExtraction, transcriptFrom, EXTRACT_SYSTEM, type Extracted } from "../lib/recovery";
import { longDateDe } from "../lib/dates-de";
import { intentFromText, type Intent } from "../lib/text-guards";
import { describeProviderOrder, parseProviderOrder, parseSttOrder, resolveProviders } from "../lib/provider-order";
import { WhisperSTT } from "../lib/whisper-stt";
import { chainTranscribers } from "../lib/stt-chain";
import { summarizeSlots, parseUhrzeit, checkRequestedTime } from "../lib/slots";

// Thorsten/Piper-TTS (über den ct-agent-Bridge-Dienst) liefert WAV, nicht das Default mp3.
const VoiceAgent = withVoice(Agent, { audioFormat: "wav" });
const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const LIGHTLLM_MODEL_ID = "local-devstral-small2";
type LlmProviderName = "auto" | "workers-ai" | "lightllm";
const SERVICE_KEY_ENUM = SERVICE_KEYS as [ServiceKey, ...ServiceKey[]];
const DAY_MS = 86_400_000;
// Aussagen "Zeit nicht frei" -- duerfen nur aus einem Werkzeugergebnis stammen.
const UNAVAILABLE_PATTERN =
  /\b(vergeben|belegt|ausgebucht|besetzt)\b|\bnicht\s+(mehr\s+)?(frei|verf[uü]gbar)\b|\bnichts\s+(mehr\s+)?frei\b/i;
// "Frei"-Aussage mit Uhrzeit. Live: Das Modell kopierte die Liste vom Freitag fuer den 4. November,
// ohne zu pruefen -> nur nach einer Verfuegbarkeitspruefung im selben Zug erlaubt.
const FREE_CLAIM_PATTERN =
  /\b\d{1,2}(:\d{2}|\s*uhr)\b[^.!?]*\b(frei|verf[uü]gbar)\b|\b(frei|verf[uü]gbar)\b[^.!?]*\b\d{1,2}(:\d{2}|\s*uhr)\b/i;
// Duzen: Der Salon spricht Gaeste mit "Sie" an.
const DU_PATTERN = /\b(du|dir|dich|dein|deine|deinen|deinem|deiner|deines)\b/i;

function newId(): string {
  return crypto.randomUUID();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

interface AppointmentRow {
  id: string;
  customer_name: string;
  phone: string;
  service: ServiceKey;
  start_ts: number;
  end_ts: number;
  status: "confirmed" | "cancelled";
  notes: string | null;
  created_at: number;
}

interface BlockerRow {
  id: string;
  start_ts: number;
  end_ts: number;
  reason: string;
  created_at: number;
}

function rowToAppointment(r: AppointmentRow): Appointment {
  return {
    id: r.id,
    customerName: r.customer_name,
    phone: r.phone,
    service: r.service,
    startTs: r.start_ts,
    endTs: r.end_ts,
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at
  };
}

function rowToBlocker(r: BlockerRow): Blocker {
  return { id: r.id, startTs: r.start_ts, endTs: r.end_ts, reason: r.reason, createdAt: r.created_at };
}

export class SalonAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new CtAgentBridgeTTS({
    bridgeUrl: this.env.AUDIO_BRIDGE_URL,
    bridgeToken: this.env.AUDIO_BRIDGE_TOKEN,
    voice: "primary"
  });

  createTranscriber(): import("@cloudflare/voice").Transcriber | null {
    const provider = this.getLlmProviderSetting();
    const createLightLlmStt = () =>
      new LightLlmSTT({
        bridgeUrl: this.env.AUDIO_BRIDGE_URL,
        bridgeToken: this.env.AUDIO_BRIDGE_TOKEN
      });
    if (provider === "lightllm") return createLightLlmStt();
    if (provider === "workers-ai") return this.transcriber ?? null;
    // "auto": Reihenfolge aus STT_PROVIDER_ORDER (Standard: lokales Whisper zuerst, dann Workers AI Flux);
    // der Kanal-Dienst (LightLLM-Streaming) bleibt letzte Rettung. Ein Fehler VOR der ersten
    // erfolgreichen Transkription wechselt transparent zum naechsten Anbieter.
    const factories: Array<() => import("@cloudflare/voice").Transcriber> = [];
    for (const name of parseSttOrder(this.env.STT_PROVIDER_ORDER)) {
      if (name === "whisper" && this.env.STT_WHISPER_URL) {
        const baseUrl = this.env.STT_WHISPER_URL;
        factories.push(() => new WhisperSTT({ baseUrl }));
      }
      if (name === "workers-ai" && this.transcriber) {
        const flux = this.transcriber;
        factories.push(() => flux);
      }
    }
    factories.push(createLightLlmStt);
    return chainTranscribers(factories);
  }

  // Gespraechsverlauf je Verbindung. Der Voice-Mixin speichert sonst EINEN Verlauf in SQLite fuer alle
  // Anrufer dieser Instanz ("default") -- live beantwortete ein neuer Besucher Fragen aus dem Gespraech
  // eines anderen (Datum, Name, Telefonnummer). Der Verlauf lebt nur im Speicher und endet mit der Verbindung.
  private readonly conversations = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
  private static readonly HISTORY_LIMIT = 20;

  saveMessage(_role: "user" | "assistant", _text: string): void {
    // bewusst leer: kein verbindungsuebergreifender Verlauf, keine Gespraechsinhalte auf Platte
  }

  getConversationHistory(_limit?: number): Array<{ role: "user" | "assistant"; content: string }> {
    return [];
  }

  onClose(connection: Connection) {
    this.conversations.delete(connection.id);
  }

  onStart() {
    // Altbestand des geteilten Verlaufs entfernen (enthielt Namen und Telefonnummern frueherer Anrufer).
    try {
      this.sql`DELETE FROM cf_voice_messages`;
    } catch {
      // Tabelle existiert noch nicht
    }
    this.sql`CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      service TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      notes TEXT,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS blockers (
      id TEXT PRIMARY KEY,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`;
    const order = parseProviderOrder(this.env.LLM_PROVIDER_ORDER);
    console.log(
      `[config] LLM-Anbieter: ${describeProviderOrder(this.getLlmProviderSetting(), order)}; ` +
        `LiteLLM ${this.env.LIGHTLLM_BASE_URL} Modell ${this.env.LIGHTLLM_MODEL || LIGHTLLM_MODEL_ID}; ` +
        `Workers AI Modell ${this.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL}`
    );
    console.log(
      `[config] STT-Anbieter (auto): ${parseSttOrder(this.env.STT_PROVIDER_ORDER).join(" -> ")} -> kanal; ` +
        `Whisper ${this.env.STT_WHISPER_URL ?? "(nicht konfiguriert)"}`
    );
  }

  private getLlmProviderSetting(): LlmProviderName {
    const rows = this.sql<{ value: string }>`SELECT value FROM settings WHERE key = 'llm_provider'`;
    const value = rows[0]?.value;
    return value === "workers-ai" || value === "lightllm" ? value : "auto";
  }

  private setLlmProviderSetting(value: LlmProviderName) {
    this.sql`INSERT INTO settings (key, value) VALUES ('llm_provider', ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  async onCallStart(connection: Connection) {
    await this.speak(connection, `Hallo, hier ist ${this.env.SALON_NAME}. Wie kann ich Ihnen helfen?`);
  }

  // ---------------------------------------------------------------------
  // Datenzugriff
  // ---------------------------------------------------------------------

  private appointmentsAround(centerMs: number, windowDays = 3): Appointment[] {
    const from = centerMs - windowDays * DAY_MS;
    const to = centerMs + windowDays * DAY_MS;
    const rows = this.sql<AppointmentRow>`SELECT * FROM appointments WHERE start_ts >= ${from} AND start_ts <= ${to}`;
    return rows.map(rowToAppointment);
  }

  private blockersAround(centerMs: number, windowDays = 3): Blocker[] {
    const from = centerMs - windowDays * DAY_MS;
    const to = centerMs + windowDays * DAY_MS;
    const rows = this.sql<BlockerRow>`SELECT * FROM blockers WHERE start_ts <= ${to} AND end_ts >= ${from}`;
    return rows.map(rowToBlocker);
  }

  // ---------------------------------------------------------------------
  // Sprachagent: Werkzeuge & Gesprächslogik
  // ---------------------------------------------------------------------

  // Rohangaben (Aktion, Name, Telefon, Datum ...) als JSON aus dem Gespraech lesen. Fehler -> null.
  private async extractIntent(messages: unknown[]): Promise<Extracted | null> {
    try {
      const model = createOpenAICompatible({
        name: "lightllm",
        baseURL: this.env.LIGHTLLM_BASE_URL,
        apiKey: this.env.LIGHTLLM_API_KEY
      })(this.env.LIGHTLLM_MODEL || LIGHTLLM_MODEL_ID);
      const { text } = await generateText({
        model,
        system: EXTRACT_SYSTEM,
        prompt: `Heute ist ${longDateDe(toDateStr(Date.now()))}.\n\nGespräch:\n${transcriptFrom(messages)}\n\nJSON:`,
        temperature: 0,
        maxOutputTokens: 300
      });
      return parseExtraction(text);
    } catch (err) {
      console.warn("[recover] Extraktion fehlgeschlagen", err);
      return null;
    }
  }

  // Letzte Nachricht des Gastes (fuer die Absichts-Sperre der Werkzeuge).
  private lastUserText = "";

  // Verwechselte Aktion verhindern: Sagt der Gast "absagen", darf keine Buchung ausgefuehrt werden.
  private intentConflict(tool: Intent): Record<string, unknown> | null {
    const intent = intentFromText(this.lastUserText);
    if (intent && intent !== tool) {
      return {
        status: "abgelehnt",
        hinweis: `Der Gast moechte ${intent}, nicht ${tool}. Fuehre ${intent} aus bzw. frage nach.`
      };
    }
    return null;
  }

  // Signal an alle verbundenen Seiten: Die Uebersicht "Wie frei sind wir?" neu laden.
  private notifyAvailabilityChanged() {
    try {
      this.broadcast(JSON.stringify({ type: "availability_changed" }));
    } catch (err) {
      console.warn("[availability] Broadcast fehlgeschlagen", err);
    }
  }

  // Findet den gemeinten, kuenftigen Termin. Die termin_id aus einem frueheren Gespraechszug
  // steht nicht mehr im Verlauf (nur Text wird gespeichert); deshalb ist die Telefonnummer
  // ein gleichwertiger Schluessel. Frei erfundene IDs duerfen nie zu "Erfolg" fuehren.
  private resolveAppointment(
    terminId: string | undefined,
    telefon: string | undefined
  ): { ok: true; appt: Appointment } | { ok: false; result: Record<string, unknown> } {
    const now = Date.now();
    if (terminId) {
      const rows = this.sql<AppointmentRow>`SELECT * FROM appointments WHERE id = ${terminId} AND status = 'confirmed'`;
      if (rows.length > 0) return { ok: true, appt: rowToAppointment(rows[0]) };
    }
    if (telefon) {
      const rows = this.sql<AppointmentRow>`SELECT * FROM appointments
        WHERE phone = ${telefon} AND status = 'confirmed' AND start_ts >= ${now} ORDER BY start_ts ASC`;
      if (rows.length === 1) return { ok: true, appt: rowToAppointment(rows[0]) };
      if (rows.length > 1) {
        return {
          ok: false,
          result: {
            status: "mehrere_termine",
            hinweis: "Mehrere Termine gefunden. Den Gast fragen, welcher gemeint ist, dann dessen termin_id verwenden.",
            termine: rows.map((r) => {
              const a = rowToAppointment(r);
              return {
                termin_id: a.id,
                leistung: SERVICES[a.service].label,
                wann: `${formatDateHumanDe(toDateStr(a.startTs))} um ${toTimeStr(a.startTs)} Uhr`
              };
            })
          }
        };
      }
    }
    return {
      ok: false,
      result: {
        status: "nicht_gefunden",
        hinweis: "Termin nicht gefunden. Den Gast nach der Telefonnummer fragen und diese als telefon uebergeben."
      }
    };
  }

  private buildTools() {
    const self = this;
    return {
      pruefe_verfuegbarkeit: tool({
        description:
          "Prüft freie Termin-Slots an einem bestimmten Datum für eine Leistung. Nennt der Gast eine bestimmte Uhrzeit, übergib sie IMMER als uhrzeit; nur so erfährst du verlässlich, ob genau diese Zeit frei ist.",
        inputSchema: z.object({
          datum: z.string().describe("Datum im Format YYYY-MM-DD"),
          leistung: z.enum(SERVICE_KEY_ENUM),
          uhrzeit: z.string().optional().describe("Gewünschte Uhrzeit, z.B. 10:00 oder 10 Uhr")
        }),
        execute: async ({ datum, leistung, uhrzeit }) => {
          const now = Date.now();
          if (!isWithinBookingHorizon(datum, now)) {
            return { status: "zu_weit_in_zukunft", hinweis: "Termine sind maximal 60 Tage im Voraus buchbar." };
          }
          const dayStartMs = zonedTimeToUtcMs(datum, "00:00");
          const appts = self.appointmentsAround(dayStartMs);
          const blockers = self.blockersAround(dayStartMs);
          const slots = getAvailableSlots({ dateStr: datum, service: leistung, appointments: appts, blockers, now });
          if (slots.length === 0) {
            return { status: "keine_freien_slots", wochentag: weekdayNameDe(datum) };
          }
          // Vollstaendige Liste plus fertiger Satz: das Modell soll Uhrzeiten nicht neu abtippen.
          const summary = summarizeSlots(slots.map((s) => toTimeStr(s)), SLOT_STEP_MIN);
          const requested = uhrzeit ? parseUhrzeit(uhrzeit) : null;
          // Die vollstaendige Liste bleibt intern (gewuenschte_zeit); das Modell bekommt nur die Zeitfenster,
          // sonst liest es am Telefon jede einzelne Startzeit vor (live: 15 Uhrzeiten am Stueck).
          const { freie_zeiten, ...spoken } = summary;
          return {
            status: "ok",
            wochentag: weekdayNameDe(datum),
            ...spoken,
            anzahl_freie_startzeiten: freie_zeiten.length,
            // Ob GENAU die gewuenschte Zeit frei ist, entscheidet nur dieses Feld.
            ...(uhrzeit
              ? {
                  gewuenschte_zeit: requested
                    ? checkRequestedTime(requested, summary.freie_zeiten)
                    : { hinweis: "Uhrzeit nicht lesbar, bitte beim Gast nachfragen." }
                }
              : {})
          };
        }
      }),
      termin_buchen: tool({
        description: "Bucht einen neuen Termin, nachdem die Verfügbarkeit geprüft und bestätigt wurde.",
        inputSchema: z.object({
          name: z.string().describe("Name des Kunden"),
          telefon: z.string().describe("Telefonnummer des Kunden"),
          leistung: z.enum(SERVICE_KEY_ENUM),
          datum: z.string().describe("YYYY-MM-DD"),
          uhrzeit: z.string().describe("HH:mm")
        }),
        execute: async ({ name, telefon, leistung, datum, uhrzeit }) => {
          const conflict = self.intentConflict("buchen");
          if (conflict) return conflict;
          const now = Date.now();
          const startTs = zonedTimeToUtcMs(datum, uhrzeit);
          const endTs = startTs + SERVICES[leistung].durationMin * 60000;
          if (startTs < now + 30 * 60000) {
            return { status: "zu_kurzfristig" };
          }
          const appts = self.appointmentsAround(startTs);
          const blockers = self.blockersAround(startTs);
          if (!isSlotFree({ startTs, endTs, appointments: appts, blockers })) {
            return { status: "belegt" };
          }
          const apptId = newId();
          self.sql`INSERT INTO appointments (id, customer_name, phone, service, start_ts, end_ts, status, created_at)
            VALUES (${apptId}, ${name}, ${telefon}, ${leistung}, ${startTs}, ${endTs}, 'confirmed', ${now})`;
          self.notifyAvailabilityChanged();
          return {
            status: "gebucht",
            termin_id: apptId,
            bestaetigung: `${formatDateHumanDe(datum)} um ${uhrzeit} Uhr`
          };
        }
      }),
      termine_suchen: tool({
        description: "Findet bestehende, künftige Termine anhand der Telefonnummer (nötig vor Umbuchung/Absage).",
        inputSchema: z.object({ telefon: z.string() }),
        execute: async ({ telefon }) => {
          const now = Date.now();
          const rows = self.sql<AppointmentRow>`SELECT * FROM appointments
            WHERE phone = ${telefon} AND status = 'confirmed' AND start_ts >= ${now}
            ORDER BY start_ts ASC`;
          const appts = rows.map(rowToAppointment);
          if (appts.length === 0) return { status: "keine_termine" };
          return {
            status: "ok",
            termine: appts.map((a) => ({
              termin_id: a.id,
              leistung: SERVICES[a.service].label,
              wann: `${formatDateHumanDe(toDateStr(a.startTs))} um ${toTimeStr(a.startTs)} Uhr`
            }))
          };
        }
      }),
      termin_absagen: tool({
        description:
          "Sagt einen bestehenden Termin ab. Uebergib die Telefonnummer des Gastes (telefon); termin_id nur, wenn du sie in diesem Gespraechszug aus termine_suchen kennst.",
        inputSchema: z.object({ termin_id: z.string().optional(), telefon: z.string().optional() }),
        execute: async ({ termin_id, telefon }) => {
          const conflict = self.intentConflict("absagen");
          if (conflict) return conflict;
          const found = self.resolveAppointment(termin_id, telefon);
          if (!found.ok) return found.result;
          self.sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${found.appt.id} AND status = 'confirmed'`;
          self.notifyAvailabilityChanged();
          return {
            status: "abgesagt",
            wann: `${formatDateHumanDe(toDateStr(found.appt.startTs))} um ${toTimeStr(found.appt.startTs)} Uhr`
          };
        }
      }),
      termin_verschieben: tool({
        description:
          "Verschiebt einen bestehenden Termin auf ein neues Datum/Uhrzeit. Uebergib die Telefonnummer des Gastes (telefon); termin_id nur, wenn du sie in diesem Gespraechszug aus termine_suchen kennst.",
        inputSchema: z.object({
          termin_id: z.string().optional(),
          telefon: z.string().optional(),
          neues_datum: z.string().describe("YYYY-MM-DD"),
          neue_uhrzeit: z.string().describe("HH:mm")
        }),
        execute: async ({ termin_id, telefon, neues_datum, neue_uhrzeit }) => {
          const conflict = self.intentConflict("verschieben");
          if (conflict) return conflict;
          const found = self.resolveAppointment(termin_id, telefon);
          if (!found.ok) return found.result;
          const appt = found.appt;
          const newStart = zonedTimeToUtcMs(neues_datum, neue_uhrzeit);
          const newEnd = newStart + SERVICES[appt.service].durationMin * 60000;
          const dayAppts = self.appointmentsAround(newStart);
          const dayBlockers = self.blockersAround(newStart);
          if (
            !isSlotFree({
              startTs: newStart,
              endTs: newEnd,
              appointments: dayAppts,
              blockers: dayBlockers,
              excludeAppointmentId: appt.id
            })
          ) {
            return { status: "belegt" };
          }
          self.sql`UPDATE appointments SET start_ts = ${newStart}, end_ts = ${newEnd} WHERE id = ${appt.id}`;
          self.notifyAvailabilityChanged();
          return { status: "verschoben", bestaetigung: `${formatDateHumanDe(neues_datum)} um ${neue_uhrzeit} Uhr` };
        }
      })
    };
  }

  private streamFromProvider(
    providerName: "workers-ai" | "lightllm",
    system: string,
    messages: unknown[],
    tools: ToolSet,
    options?: StreamOptions
  ) {
    const model =
      providerName === "workers-ai"
        ? createWorkersAI({ binding: this.env.AI })((this.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL) as never)
        : createOpenAICompatible({
            name: "lightllm",
            baseURL: this.env.LIGHTLLM_BASE_URL,
            apiKey: this.env.LIGHTLLM_API_KEY
          })(this.env.LIGHTLLM_MODEL || LIGHTLLM_MODEL_ID);
    const result = streamText({
      model,
      system,
      // biome-ignore lint: messages shape is validated by streamText itself
      messages: messages as never,
      tools,
      // Korrekturversuch: im ersten Schritt ein Werkzeug erzwingen, danach wieder frei ("auto").
      ...(options?.toolChoice
        ? { prepareStep: ({ stepNumber }: { stepNumber: number }) => (stepNumber === 0 ? { toolChoice: options.toolChoice } : {}) }
        : {}),
      stopWhen: stepCountIs(5)
    });
    return result.stream;
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const system = buildSystemPrompt({ salonName: this.env.SALON_NAME, nowMs: Date.now() });
    const history = this.conversations.get(context.connection.id) ?? [];
    const messages = [...history, { role: "user", content: transcript }];
    this.lastUserText = transcript;
    const tools = this.buildTools();
    const forced = this.getLlmProviderSetting();
    // "auto": Reihenfolge aus LLM_PROVIDER_ORDER (Standard: LiteLLM zuerst, Workers AI als Rueckfall). Werkzeugaufrufe, die ein Modell als JSON-Text
    // ausgibt, werden erkannt und ausgefuehrt; leere Antworten werden wiederholt und
    // enden notfalls in einem freundlichen Ersatzsatz (siehe lib/turn-runner.ts).
    const providers = resolveProviders(forced, parseProviderOrder(this.env.LLM_PROVIDER_ORDER));
    const text = await runTurnWithRepair({
      providers,
      stream: (provider, msgs, options) =>
        this.streamFromProvider(provider as "workers-ai" | "lightllm", system, msgs, tools, options),
      tools,
      messages,
      doubledDeltaProviders: ["workers-ai"],
      renderResult: renderToolOutput,
      recover: async () => {
        const recovered = await recoverTurn({
          extract: () => this.extractIntent(messages),
          callTool: async (name, args) => (await executeLeaked(tools, name, args)) as Record<string, unknown>,
          nowMs: Date.now(),
          log: (msg, detail) => console.warn(`[recover] ${msg}`, detail ?? "")
        });
        console.warn("[recover] Ergebnis:", recovered ?? "(nichts)");
        return recovered;
      },
      claimGuards: [
        {
          // Buchungsbehauptung: auch "bestätigt/reserviert/eingetragen" zaehlen -- ausser bei Absage-Wortlaut.
          pattern: /\b(gebucht|reserviert|eingetragen|vorgemerkt)\b|\btermin\b[^.!?]*\bbest[aä]tigt\b/i,
          unless: /\b(abgesagt|storniert|verschoben|umgebucht)\b/i,
          tools: ["termin_buchen"]
        },
        { pattern: /\b(abgesagt|storniert)\b/i, tools: ["termin_absagen"] },
        { pattern: /\b(verschoben|umgebucht)\b/i, tools: ["termin_verschieben"] },
        {
          // "vergeben/nicht frei" nur, wenn die Pruefung GENAU diese Zeit als nicht frei gemeldet hat.
          mode: "unavailable",
          forceTool: "pruefe_verfuegbarkeit",
          pattern: UNAVAILABLE_PATTERN,
          hint:
            "[Systemhinweis, nicht vom Gast] Du hast eine Uhrzeit als vergeben oder nicht frei bezeichnet, ohne dass die Verfuegbarkeitspruefung genau diese Zeit als nicht frei gemeldet hat. Rufe die Verfuegbarkeitspruefung mit dem Parameter uhrzeit auf und gib nur deren Ergebnis wieder."
        },
        {
          mode: "checked",
          tools: ["pruefe_verfuegbarkeit"],
          forceTool: "pruefe_verfuegbarkeit",
          pattern: FREE_CLAIM_PATTERN,
          unless: UNAVAILABLE_PATTERN,
          hint:
            "[Systemhinweis, nicht vom Gast] Du hast freie Uhrzeiten genannt, ohne in diesem Zug die Verfuegbarkeitspruefung aufzurufen. Frueher genannte Zeiten gelten nicht fuer einen anderen Tag. Rufe die Verfuegbarkeitspruefung fuer das gefragte Datum auf und uebernimm deren antwort_text."
        },
        {
          mode: "style",
          pattern: DU_PATTERN,
          hint:
            "[Systemhinweis, nicht vom Gast] Sprich den Gast durchgehend mit Sie an (Sie, Ihnen, Ihr), niemals mit du, dir oder dein. Formuliere deine letzte Antwort entsprechend neu."
        }
      ],
      log: (msg, detail) => console.warn(`[turn] ${msg}`, detail ?? "")
    });
    history.push({ role: "user", content: transcript }, { role: "assistant", content: text });
    this.conversations.set(context.connection.id, history.slice(-SalonAgent.HISTORY_LIMIT));
    return (async function* () {
      yield { type: "text-delta", id: "reply", text };
    })();
  }

  // ---------------------------------------------------------------------
  // HTTP: öffentliche Verfügbarkeit + Admin-API
  // ---------------------------------------------------------------------

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/agents\/salon-agent\/[^/]+/, "") || "/";

    if (request.method === "GET" && path === "/availability") {
      return this.handleAvailability(url);
    }
    if (request.method === "POST" && path === "/admin/login") {
      return this.handleAdminLogin(request);
    }

    if (path.startsWith("/admin/")) {
      const authorized = await this.isAdminRequest(request);
      if (!authorized) return json({ error: "unauthorized" }, 401);

      if (request.method === "GET" && path === "/admin/appointments") {
        return this.handleAdminListAppointments();
      }
      if (request.method === "DELETE" && path.startsWith("/admin/appointments/")) {
        const apptId = decodeURIComponent(path.split("/").pop() ?? "");
        this.sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${apptId}`;
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/admin/blockers") {
        return this.handleAdminListBlockers();
      }
      if (request.method === "POST" && path === "/admin/blockers") {
        return this.handleAdminAddBlocker(request);
      }
      if (request.method === "DELETE" && path.startsWith("/admin/blockers/")) {
        const blockerId = decodeURIComponent(path.split("/").pop() ?? "");
        this.sql`DELETE FROM blockers WHERE id = ${blockerId}`;
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/admin/settings") {
        return json({ llmProvider: this.getLlmProviderSetting() });
      }
      if (request.method === "POST" && path === "/admin/settings") {
        const body = (await request.json().catch(() => null)) as { llmProvider?: string } | null;
        if (body?.llmProvider !== "auto" && body?.llmProvider !== "workers-ai" && body?.llmProvider !== "lightllm") {
          return json({ error: "invalid_llm_provider" }, 400);
        }
        this.setLlmProviderSetting(body.llmProvider);
        return json({ ok: true, llmProvider: body.llmProvider });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  private handleAvailability(url: URL): Response {
    const now = Date.now();
    const dateParam = url.searchParams.get("date");
    const serviceParam = (url.searchParams.get("service") as ServiceKey | null) ?? "schneiden_kurz";

    if (dateParam) {
      if (!isWithinBookingHorizon(dateParam, now)) {
        return json({ date: dateParam, closed: false, slots: [] as string[], hinweis: "außerhalb des Buchungszeitraums" });
      }
      const dayStartMs = zonedTimeToUtcMs(dateParam, "00:00");
      const closed = !OPENING_HOURS[weekdayOfDateStr(dateParam)];
      const slots = closed
        ? []
        : getAvailableSlots({
            dateStr: dateParam,
            service: serviceParam,
            appointments: this.appointmentsAround(dayStartMs),
            blockers: this.blockersAround(dayStartMs),
            now
          });
      return json({
        date: dateParam,
        weekday: weekdayNameDe(dateParam),
        closed,
        slots: slots.map((s) => toTimeStr(s))
      });
    }

    const days = Math.min(Number(url.searchParams.get("days")) || 14, 30);
    const result = [];
    for (let i = 0; i < days; i++) {
      const dayMs = now + i * DAY_MS;
      const dateStr = toDateStr(dayMs);
      const closed = !OPENING_HOURS[weekdayOfDateStr(dateStr)];
      let freeCount = 0;
      if (!closed) {
        const dayStartMs = zonedTimeToUtcMs(dateStr, "00:00");
        freeCount = getAvailableSlots({
          dateStr,
          service: serviceParam,
          appointments: this.appointmentsAround(dayStartMs),
          blockers: this.blockersAround(dayStartMs),
          now
        }).length;
      }
      result.push({ date: dateStr, weekday: weekdayNameDe(dateStr), closed, freeCount });
    }
    return json(result);
  }

  private async handleAdminLogin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { password?: string } | null;
    if (!body?.password || body.password !== this.env.ADMIN_PASSWORD) {
      return json({ error: "invalid_password" }, 401);
    }
    const token = newId();
    const expiresAt = Date.now() + 12 * 3600_000;
    this.sql`INSERT INTO admin_sessions (token, expires_at) VALUES (${token}, ${expiresAt})`;
    return json({ token, expiresAt });
  }

  private async isAdminRequest(request: Request): Promise<boolean> {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return false;
    const rows = this.sql<{ expires_at: number }>`SELECT expires_at FROM admin_sessions WHERE token = ${token}`;
    return rows.length > 0 && rows[0].expires_at > Date.now();
  }

  private handleAdminListAppointments(): Response {
    const from = Date.now() - 7 * DAY_MS;
    const rows = this.sql<AppointmentRow>`SELECT * FROM appointments WHERE start_ts >= ${from} ORDER BY start_ts ASC LIMIT 300`;
    const appts = rows.map(rowToAppointment);
    return json(
      appts.map((a) => ({
        id: a.id,
        name: a.customerName,
        phone: a.phone,
        service: SERVICES[a.service].label,
        date: toDateStr(a.startTs),
        time: toTimeStr(a.startTs),
        status: a.status
      }))
    );
  }

  private handleAdminListBlockers(): Response {
    const from = Date.now() - 7 * DAY_MS;
    const rows = this.sql<BlockerRow>`SELECT * FROM blockers WHERE end_ts >= ${from} ORDER BY start_ts ASC LIMIT 300`;
    const blockers = rows.map(rowToBlocker);
    return json(
      blockers.map((b) => ({
        id: b.id,
        reason: b.reason,
        startDate: toDateStr(b.startTs),
        startTime: toTimeStr(b.startTs),
        endDate: toDateStr(b.endTs),
        endTime: toTimeStr(b.endTs)
      }))
    );
  }

  private async handleAdminAddBlocker(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      startDate?: string;
      startTime?: string;
      endDate?: string;
      endTime?: string;
      reason?: string;
    } | null;
    if (!body?.startDate || !body.startTime || !body.endDate || !body.endTime || !body.reason) {
      return json({ error: "missing_fields" }, 400);
    }
    const startTs = zonedTimeToUtcMs(body.startDate, body.startTime);
    const endTs = zonedTimeToUtcMs(body.endDate, body.endTime);
    if (endTs <= startTs) return json({ error: "invalid_range" }, 400);
    const blockerId = newId();
    this.sql`INSERT INTO blockers (id, start_ts, end_ts, reason, created_at)
      VALUES (${blockerId}, ${startTs}, ${endTs}, ${body.reason}, ${Date.now()})`;
    return json({ ok: true, id: blockerId });
  }
}
