import { CropNorm } from './runtime';

export const MIN_CROP = 0.08;

export type CropGrip = 'left' | 'right' | 'top' | 'bottom' | 'tl' | 'tr' | 'bl' | 'br';

function snap(value: number) {
  return Math.round(value * 1e6) / 1e6;
}

function edges(left: number, top: number, right: number, bottom: number): CropNorm {
  return {
    x: snap(left),
    y: snap(top),
    width: snap(right - left),
    height: snap(bottom - top),
  };
}
function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** 只移动被拖的边。对边保持不动，拖出画面时停在边界。 */
export function applyGrip(
  start: CropNorm,
  grip: CropGrip,
  dx: number,
  dy: number,
  frameW: number,
  frameH: number,
): CropNorm {
  const mx = frameW > 0 ? dx / frameW : 0;
  const my = frameH > 0 ? dy / frameH : 0;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  const movesLeft = grip === 'left' || grip === 'tl' || grip === 'bl';
  const movesRight = grip === 'right' || grip === 'tr' || grip === 'br';
  const movesTop = grip === 'top' || grip === 'tl' || grip === 'tr';
  const movesBottom = grip === 'bottom' || grip === 'bl' || grip === 'br';
  if (movesLeft) left = clamp(left + mx, 0, right - MIN_CROP);
  if (movesRight) right = clamp(right + mx, left + MIN_CROP, 1);
  if (movesTop) top = clamp(top + my, 0, bottom - MIN_CROP);
  if (movesBottom) bottom = clamp(bottom + my, top + MIN_CROP, 1);
  return edges(left, top, right, bottom);
}

/** 改宽度只动右边，改高度只动下边。 */
export function setCropWidth(crop: CropNorm, width: number): CropNorm {
  const right = clamp(crop.x + width, crop.x + MIN_CROP, 1);
  return edges(crop.x, crop.y, right, crop.y + crop.height);
}

export function normalizeCrop(crop: CropNorm): CropNorm {
  let left = crop.x;
  let top = crop.y;
  let right = crop.x + crop.width;
  let bottom = crop.y + crop.height;
  left = clamp(left, 0, 1 - MIN_CROP);
  right = clamp(right, left + MIN_CROP, 1);
  top = clamp(top, 0, 1 - MIN_CROP);
  bottom = clamp(bottom, top + MIN_CROP, 1);
  return edges(left, top, right, bottom);
}

export function setCropHeight(crop: CropNorm, height: number): CropNorm {
  const bottom = clamp(crop.y + height, crop.y + MIN_CROP, 1);
  return edges(crop.x, crop.y, crop.x + crop.width, bottom);
}
