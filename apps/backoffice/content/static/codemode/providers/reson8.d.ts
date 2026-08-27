// reson8 tools
type Reson8CodemodeProvider = {
  /** Transcribe a prerecorded audio file via Reson8. */
  transcribePrerecorded(
    input: Reson8TranscribePrerecordedInput,
  ): Promise<Reson8TranscribePrerecordedOutput>;
};
declare const reson8: Reson8CodemodeProvider;

type Reson8TranscribePrerecordedInput = {
  audio:
    | { kind: "arrayBuffer"; arrayBuffer: ArrayBuffer }
    | { kind: "arrayBufferView"; arrayBufferView: ArrayBufferView }
    | { kind: "bytes"; bytes: number[] };
  encoding?: "auto" | "pcm_s16le";
  sampleRate?: number;
  channels?: number;
  customModelId?: string;
  includeTimestamps?: boolean;
  includeWords?: boolean;
  includeConfidence?: boolean;
};
type Reson8TranscribePrerecordedOutput = {
  text: string;
  start_ms?: number;
  duration_ms?: number;
  words?: {
    text: string;
    start_ms?: number;
    duration_ms?: number;
    confidence?: number;
  }[];
};
