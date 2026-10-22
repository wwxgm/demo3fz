export type SmearBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MIN_BOX = 0.02;

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function snap(value: number) {
  return Math.round(value * 1e6) / 1e6;
}

/** 围绕当前区域中心放大或缩小，超出画面时停在边上。 */
export function scaleBox(box: SmearBox, factor: number): SmearBox {
  const width = clamp(box.width * factor, MIN_BOX, 1);
  const height = clamp(box.height * factor, MIN_BOX, 1);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const x = clamp(centerX - width / 2, 0, 1 - width);
  const y = clamp(centerY - height / 2, 0, 1 - height);
  return { x: snap(x), y: snap(y), width: snap(width), height: snap(height) };
}

export function checkSmearTime(
  start: number,
  end: number,
  duration?: number,
): { ok: true; start: number; end: number } | { ok: false; message: string } {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start + 0.04) {
    return { ok: false, message: '开始要小于结束' };
  }
  if (duration && duration > 0 && start >= duration - 0.04) {
    return { ok: false, message: '开始时间已经超出视频' };
  }
  const clipped = duration && duration > 0 ? Math.min(end, duration) : end;
  if (clipped <= start + 0.04) {
    return { ok: false, message: '这个时间范围里没有可涂抹的画面' };
  }
  return { ok: true, start, end: clipped };
}
