import { requireNativeModule } from 'expo-modules-core';

type VideoFlipNative = {
  flipHorizontal(uri: string): Promise<string>;
  removeTempFile(uri: string): void;
};

const missing: VideoFlipNative = {
  async flipHorizontal() {
    throw new Error('当前安装包没有视频翻转模块，请重新打包 IPA 后再使用');
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
