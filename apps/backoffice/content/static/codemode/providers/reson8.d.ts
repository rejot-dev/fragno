// reson8 tools
type Reson8CodemodeProvider = {
  /** Transcribe a prerecorded audio file from the workspace with Reson8. */
  transcribePrerecorded(
    input: Reson8TranscribePrerecordedInput,
  ): Promise<Reson8TranscribePrerecordedOutput>;
  /** Mint a short-lived Reson8 token for streaming audio to Reson8 directly. Open a WebSocket to url with the subprotocols bearer and the access token, send audio as binary frames, and read transcript messages. The audio does not pass through Backoffice, so realtime transcription is not billed. */
  createRealtimeToken(): Promise<Reson8CreateRealtimeTokenOutput>;
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
type Reson8CreateRealtimeTokenOutput = {
  /** Short-lived Reson8 token; it is not a Backoffice credential */
  accessToken: string;
  /** Seconds until the token expires */
  expiresIn: number;
  /** Realtime WebSocket endpoint; append query options such as encoding, sample_rate, or include_interim */
  url: string;
};
