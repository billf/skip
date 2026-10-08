/**
 * The checkpoint emitter (KTD4): public API every consumer source (1a, 1b,
 * 1c, and U11's reference service) calls for each source group or
 * transition, after that group's `writer.update` resolves. Skip notifies a
 * stream only when its output changes, so a step with no output change
 * publishes nothing on the feed; the checkpoint emitter is how such a step
 * still settles for a reader watching only published output.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U7,
 * KTD4.
 */

export type CheckpointSink = (frame: string) => void;

/** Formats one `event: checkpoint` SSE frame carrying `version`. */
export function formatCheckpointFrame(version: number): string {
  return `event: checkpoint\ndata: ${JSON.stringify({ version })}\n\n`;
}

/**
 * Fans a `checkpoint(version)` call out to every currently-open stream's
 * sink. A stream-route helper (U8's `sse_reader` counterpart on the write
 * side) registers one sink per open connection; this class holds no
 * transport of its own.
 *
 * Fan-out isolates per-sink failures: a throwing sink (e.g. a dead SSE
 * connection) must not starve the sinks iterated after it. Each failure is
 * reported to `onSinkError` (the transport's error path: log, count, or
 * remove the dead sink) and the loop continues with the remaining sinks.
 */
export class CheckpointEmitter {
  private readonly sinks = new Set<CheckpointSink>();

  constructor(
    private readonly onSinkError: (
      sink: CheckpointSink,
      error: unknown,
    ) => void = () => {},
  ) {}

  addSink(sink: CheckpointSink): void {
    this.sinks.add(sink);
  }

  removeSink(sink: CheckpointSink): void {
    this.sinks.delete(sink);
  }

  get sinkCount(): number {
    return this.sinks.size;
  }

  /** Writes `event: checkpoint` carrying `version` to every open stream. */
  checkpoint(version: number): void {
    const frame = formatCheckpointFrame(version);
    for (const sink of this.sinks) {
      try {
        sink(frame);
      } catch (error) {
        this.onSinkError(sink, error);
      }
    }
  }
}
