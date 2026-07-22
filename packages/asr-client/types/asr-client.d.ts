// Type definitions for @evl/asr-client — headless browser client for the
// EVL ASR proxy. License: BSD-3-Clause.

/** Options accepted by the constructor and configure(). */
export interface AsrClientOptions {
  /** Proxy base URL: "https://host/path", "/path", or "" (same origin). */
  serverUrl: string;
  /** Label speakers (server default when omitted). */
  diarization?: boolean;
  /** Expected speaker count, 1–8 (server default when omitted). */
  maxSpeakers?: number;
  /** Automatic punctuation (server default when omitted). */
  punctuation?: boolean;
  /** Microphone deviceId from listMicrophones(); system default when omitted. */
  deviceId?: string;
  /** Mic processing (default true). */
  echoCancellation?: boolean;
  /** Mic processing (default true). */
  noiseSuppression?: boolean;
  /** Mic processing (default false: AGC distorts diarization cues). */
  autoGain?: boolean;
  /** Auto-reconnect the socket while running (default true). */
  reconnect?: boolean;
  /** Keep the streamed PCM so getWav() works (default false; ~10 min cap). */
  captureAudio?: boolean;
  /** Override the inlined AudioWorklet URL (CSP without blob:). */
  workletUrl?: string;
  /**
   * Opt in to the proxy's background analyzers (topics, summaries, ...) for
   * this session; results arrive as "analysis" events. Default false so
   * embedded pages don't silently trigger server-side LLM calls.
   */
  analyzers?: boolean;
}

/** A finalized transcript segment. */
export interface Segment {
  text: string;
  /** Speaker id (e.g. "0") or null when diarization is off. */
  speaker: string | null;
  /** Milliseconds since start() when the segment arrived. */
  tMs: number;
}

export type StatusState =
  | "idle" | "connecting" | "listening" | "paused" | "reconnecting"
  | "finalizing" | "full" | "error" | "closed";

/** A background-analyzer result pushed by the proxy. */
export interface AnalysisMessage {
  id: string;
  name: string;
  result?: string;
  error?: string;
  ts: number;
}

export interface Microphone {
  deviceId: string;
  label: string;
}

/** The proxy's GET /config payload. */
export interface ServerInfo {
  sample_rate: number;
  language: string;
  model: string;
  llm: boolean;
  llm_model: string;
  sessions: number;
  diarization: boolean;
  max_speakers: number;
  auto_punct: boolean;
  endpointing: boolean;
}

export interface AsrClientEventMap {
  /** Live hypothesis (replace-style). */
  interim: (text: string) => void;
  /** Finalized segment. */
  segment: (segment: Segment) => void;
  /** A new speaker id first appeared. */
  speaker: (id: string) => void;
  /** Connection/session state ("full" carries the server's message). */
  status: (state: StatusState, message?: string) => void;
  /** Background-analyzer result from the proxy. */
  analysis: (msg: AnalysisMessage) => void;
  /** A server-side LLM call is in flight. */
  ai_running: (running: boolean) => void;
  /** ASR error reported by the proxy. */
  error: (err: Error) => void;
}

export default class AsrClient {
  constructor(options: AsrClientOptions);

  static version: string;
  /** Available audio inputs (labels appear after a mic permission grant). */
  static listMicrophones(): Promise<Microphone[]>;

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof AsrClientEventMap>(event: K, fn: AsrClientEventMap[K]): () => void;
  off<K extends keyof AsrClientEventMap>(event: K, fn: AsrClientEventMap[K]): void;

  /** Merge options; ASR/mic options apply on the next start(). */
  configure(partial: Partial<AsrClientOptions>): void;

  /** Mic permission + WebSocket connect + streaming. Resets the transcript. */
  start(): Promise<void>;
  /** Stop sending audio; keeps the session open (flushes the tail first). */
  pause(): void;
  resume(): void;
  /**
   * Flush the tail, wait (bounded) for the proxy's end-of-meeting analyzers,
   * tear down. Pass {finalize: false} to skip the analyzers and their wait —
   * fast teardown for push-to-talk style use (the tail is still transcribed).
   */
  stop(opts?: { finalize?: boolean }): Promise<void>;
  /** Hard teardown; the instance is unusable afterwards. */
  dispose(): void;

  /** Store a custom name and sync it to the proxy for the analyzers. */
  setSpeakerName(id: string | number, name: string): void;
  /** Custom name, "Speaker N", or null for a null/undefined id. */
  speakerLabel(id: string | number | null | undefined): string | null;

  /**
   * Composed plain-text transcript. {timestamps: true} gives one
   * "[MM:SS] Label: text" line per segment; otherwise consecutive
   * same-speaker segments are grouped. {names: false} keeps raw labels.
   */
  transcriptText(opts?: { timestamps?: boolean; names?: boolean }): string;

  /** Reset transcript/interim/captured audio (and names when asked). */
  clear(opts?: { names?: boolean }): void;

  /** WAV of the streamed audio (captureAudio: true), or null. */
  getWav(): Blob | null;

  /** The proxy's /config. */
  serverInfo(): Promise<ServerInfo>;

  readonly running: boolean;
  readonly paused: boolean;
  /** Treat as read-only. */
  readonly segments: ReadonlyArray<Segment>;
  readonly interim: string;
  readonly sampleRate: number;
  readonly startedAt: number;
  readonly elapsedMs: number;
  /** A copy of the custom speaker-name map. */
  readonly speakerNames: Record<string, string>;
}
