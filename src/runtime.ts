export type ItemStatus = 'pending' | 'processing' | 'saving' | 'saved' | 'failed' | 'cancelled';

export type WatermarkSettings = {
  enabled: boolean;
  text: string;
  fontSize: number;
  opacity: number;
  move: boolean;
  placeLeft: boolean;
  placeCenter: boolean;
};

export type CropNorm = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const defaultWatermark: WatermarkSettings = {
  enabled: false,
  text: '南方小猴子',
  fontSize: 16,
  opacity: 0.25,
  move: true,
  placeLeft: false,
  placeCenter: true,
};

export function watermarkPayload(settings: WatermarkSettings) {
  if (!settings.enabled) return undefined;
  const text = settings.text.trim() || '南方小猴子';
  const placeCenter = settings.placeCenter || !settings.placeLeft;
  const placeLeft = settings.placeLeft && !placeCenter;
  return {
    enabled: true as const,
    text,
    fontSize: settings.fontSize,
    opacity: settings.opacity,
    move: settings.move,
    placeLeft,
    placeCenter,
  };
}

export function errorText(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return '处理失败';
}

export function createSaveQueue() {
  let tail: Promise<void> = Promise.resolve();
  return function enqueueSave<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export async function runWithLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const current = items[cursor];
        cursor += 1;
        await worker(current);
      }
    }),
  );
}
