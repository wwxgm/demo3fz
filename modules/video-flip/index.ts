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
  cut?: {
    start: number;
    end: number;
  };
};

type VideoFlipNative = {
  flipHorizontal(uri: string, options: VideoProcessOptions): Promise<string>;
  processImage(uri: string, options: ImageProcessOptions): Promise<string>;
  sampleFrames(uri: string, count: number): Promise<string[]>;
  frameAt(uri: string, seconds: number): Promise<string>;
  makeCover(uri: string, text: string): Promise<string>;
  coverSmear(uri: string, options: {
    regions: {
      x: number;
      y: number;
      width: number;
      height: number;
      direction: 'horizontal' | 'vertical';
      start: number;
      end: number;
    }[];
  }): Promise<string>;
  coverFace(uri: string, options: {
    closedUri: string;
    openUri?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    talk?: boolean;
  }): Promise<string>;
  joinVideos(uris: string[]): Promise<string>;
  makePoster(script: string, backgroundUri: string, options?: {
    fill?: boolean;
    mute?: boolean;
    backgrounds?: { uri: string; kind: 'image' | 'video' }[];
  }): Promise<string>;
  loadPage(url: string, referer: string): Promise<string>;
  stageOriginal(uri: string): Promise<string>;
  removeTempFile(uri: string): void;
  clearProcessingCache(): number;
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
  async frameAt() {
    throw new Error(missingMessage);
  },
  async makeCover() {
    throw new Error(missingMessage);
  },
  async coverSmear() {
    throw new Error(missingMessage);
  },
  async coverFace() {
    throw new Error(missingMessage);
  },
  async joinVideos() {
    throw new Error(missingMessage);
  },
  async makePoster() {
    throw new Error(missingMessage);
  },
  async loadPage() {
    throw new Error(missingMessage);
  },
  async stageOriginal() {
    throw new Error(missingMessage);
  },
  removeTempFile() {},
  clearProcessingCache() {
    return 0;
  },
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
