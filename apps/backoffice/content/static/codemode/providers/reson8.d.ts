// reson8 tools
type Reson8CodemodeProvider = {
  /** Transcribe a prerecorded audio file from the workspace with Reson8. */
  transcribePrerecorded(
    input: Reson8TranscribePrerecordedInput,
  ): Promise<Reson8TranscribePrerecordedOutput>;
};
declare const reson8: Reson8CodemodeProvider;

type Reson8TranscribePrerecordedInput = {
  /** Audio file in the workspace, e.g. /workspace/call.wav */
  path: string;
  /** pcm_s16le for raw PCM; auto detects containers such as WAV */
  encoding?: "auto" | "pcm_s16le";
  /** Sample rate of raw PCM audio */
  sampleRate?: number;
  /** Channel count of raw PCM audio */
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
