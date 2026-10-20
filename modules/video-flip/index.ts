import { requireNativeModule } from 'expo-modules-core';

export type WatermarkPayload = {
  enabled: true;
  text: string;
  fontSize: number;
  opacity: number;
  move: boolean;
  placeLeft: boolean;
  placeCenter: boolean;
};

export type CropPayload = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageProcessOptions = {
  flip?: boolean;
  crop?: CropPayload;
  watermark?: WatermarkPayload;
};

export type HighlightMode = 'normal' | 'slow' | 'slowZoom';
export type VideoFilter = 'vivid' | 'warm' | 'cool' | 'mono';

export type VideoProcessOptions = {
  watermark?: WatermarkPayload;
  zoom?: number;
  subtitle?: string;
  extend?: {
    start: number;
    end: number;
    freeze: number;
    mode: HighlightMode;
  };
  filter?: VideoFilter;
};

type VideoFlipNative = {
  flipHorizontal(uri: string, options: VideoProcessOptions): Promise<string>;
  processImage(uri: string, options: ImageProcessOptions): Promise<string>;
  sampleFrames(uri: string, count: number): Promise<string[]>;
  joinVideos(uris: string[]): Promise<string>;
  makePoster(script: string, backgroundUri: string): Promise<string>;
  removeTempFile(uri: string): void;
};

const missingMessage = '当前安装包没有处理模块，请重新打包 IPA 后再使用';

const missing: VideoFlipNative = {
  async flipHorizontal() {
    throw new Error(missingMessage);
  },
  async processImage() {
    throw new Error(missingMessage);
  },
  async sampleFrames() {
    throw new Error(missingMessage);
  },
  async joinVideos() {
    throw new Error(missingMessage);
  },
  async makePoster() {
    throw new Error(missingMessage);
  },
  removeTempFile() {},
};

function loadNative(): VideoFlipNative {
  try {
    return requireNativeModule('VideoFlip') as VideoFlipNative;
  } catch {
    return missing;
  }
}

const VideoFlip = loadNative();

export default VideoFlip;
