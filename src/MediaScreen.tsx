import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from '../modules/video-flip';
import { CropEditor } from './CropEditor';
import { MergeScreen } from './MergeScreen';
import { FaceCoverScreen } from './FaceCoverScreen';
import { SmearScreen } from './SmearScreen';
import { WatermarkForm } from './WatermarkForm';
import { useTheme, type Palette } from './theme';
import {
  CropNorm,
  ItemStatus,
  WatermarkSettings,
  createSaveQueue,
  defaultWatermark,
  errorText,
  runWithLimit,
  watermarkPayload,
} from './runtime';

type Kind = 'video' | 'image';

type MediaItem = {
  id: string;
  uri: string;
  name: string;
  size?: number;
  durationMs?: number;
  source: '相册' | '文件';
  status: ItemStatus;
  message?: string;
  subtitle?: string;
  filter?: 'vivid' | 'warm' | 'cool' | 'mono';
  watermark?: WatermarkSettings;
  cut?: { start: string; end: string };
  sampleFrames?: boolean;
  /** 默认翻转。false 表示这一条不翻转，直接保存原视频。 */
  flip?: boolean;
  /** 翻转失败后自动改存的原视频，用来和正常翻转换成片区分。 */
  flipFallback?: boolean;
  cover?: boolean;
  coverText?: string;
  originalSaved?: boolean;
  preview?: string;
  progress?: number;
};

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mpeg|mpg)$/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|heic|heif|gif|webp|bmp|tif|tiff)$/i;

function isVideo(name: string, mimeType?: string | null) {
  if (mimeType?.startsWith('video/')) return true;
  return VIDEO_EXT.test(name);
}

function isImage(name: string, mimeType?: string | null) {
  if (mimeType?.startsWith('image/')) return true;
  return IMAGE_EXT.test(name);
}

function baseName(uri: string, fallback: string) {
  const clean = uri.split('?')[0];
  try {
    return decodeURIComponent(clean.split('/').pop() || '') || fallback;
  } catch {
    return fallback;
  }
}

function formatSize(size?: number) {
  if (!size || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const FILTERS = [
  ['', '无'],
  ['vivid', '鲜艳'],
  ['warm', '暖色'],
  ['cool', '冷色'],
  ['mono', '黑白'],
] as const;

function canKeepOriginal(item: MediaItem) {
  if (item.status === 'saved') return false;
  return !item.uri.startsWith('ph://') && !item.uri.startsWith('assets-library://');
}

function isOriginalPreview(item: MediaItem) {
  if (item.flipFallback) return true;
  if (item.flip === false && item.status === 'saved') return true;
  return item.originalSaved === true && item.status !== 'saved';
}

function formatDuration(durationMs?: number) {
  if (!durationMs || durationMs <= 0) return '';
  const total = Math.round(durationMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function MediaScreen() {
  const insets = useSafeAreaInsets();
  const { color: accent, palette } = useTheme();
  const styles = useMemo(() => createMediaStyles(palette, accent), [palette, accent]);
  const [kind, setKind] = useState<Kind>('video');
  const [videos, setVideos] = useState<MediaItem[]>([]);
  const [images, setImages] = useState<MediaItem[]>([]);
  const [watermark, setWatermark] = useState<WatermarkSettings>(defaultWatermark);
  const [zoom, setZoom] = useState(1);
  const [useCurrentClip, setUseCurrentClip] = useState(true);
  const [extendVideo, setExtendVideo] = useState(false);
  const [clipStart, setClipStart] = useState('3');
  const [clipEnd, setClipEnd] = useState('6');
  const [freezeSeconds, setFreezeSeconds] = useState('6');
  const [highlightMode, setHighlightMode] = useState<'normal' | 'slow' | 'slowZoom'>('normal');
  const [followOn, setFollowOn] = useState(false);
  const [followClip, setFollowClip] = useState<{ uri: string; name: string } | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [smearOpen, setSmearOpen] = useState(false);
  const [faceOpen, setFaceOpen] = useState(false);
  const [flipImages, setFlipImages] = useState(false);
  const [crop, setCrop] = useState<CropNorm | null>(null);
  const [cropSampleId, setCropSampleId] = useState<string | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [savingOriginalId, setSavingOriginalId] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [openSaved, setOpenSaved] = useState<Record<string, boolean>>({});
  const [previewOpen, setPreviewOpen] = useState<Record<string, boolean>>({});
  const [previewList, setPreviewList] = useState<'default' | 'all' | 'original' | 'current'>('default');
  const [batchWatermark, setBatchWatermark] = useState(false);
  const videosRef = useRef<MediaItem[]>([]);
  const nativeTail = useRef(Promise.resolve());
  const stopRef = useRef(false);
  const cancelledRef = useRef(new Set<string>());
  const runningRef = useRef(false);
  const exportingRef = useRef(false);
  const previewBusy = useRef(false);
  const activeAbort = useRef<{ id: string; abort: () => void } | null>(null);
  const savingOriginalRef = useRef<string | null>(null);
  const busy = picking;
  const items = kind === 'video' ? videos : images;
  const setItems = kind === 'video' ? setVideos : setImages;
  const sample = images.find((item) => item.id === cropSampleId) ?? images[0];

  const commitVideos = (value: MediaItem[] | ((prev: MediaItem[]) => MediaItem[])) => {
    const next = typeof value === 'function' ? value(videosRef.current) : value;
    videosRef.current = next;
    setVideos(next);
  };

  const withNative = <T,>(job: () => Promise<T>) => {
    const run = nativeTail.current.then(job, job);
    nativeTail.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const addItems = (next: MediaItem[], target: Kind) => {
    if (next.length === 0) {
      Alert.alert(target === 'video' ? '没有视频' : '没有图片', '请重新选择。');
      return;
    }
    setSummary('');
    const update = target === 'video' ? commitVideos : setImages;
    const incoming =
      target === 'video' && batchWatermark
        ? next.map((item) => ({
            ...item,
            watermark: {
              ...(item.watermark ?? defaultWatermark),
              enabled: true,
              placeLeft: true,
              placeCenter: false,
            },
          }))
        : next;
    update((prev) => {
      const seen = new Set(prev.map((item) => item.uri));
      return [...prev, ...incoming.filter((item) => !seen.has(item.uri))];
    });
    if (target === 'image') {
      setCropSampleId((current) => current ?? next[0]?.id ?? null);
    }
  };

  const missingPreview = videos.some((item) => item.preview === undefined);
  useEffect(() => {
    if (!missingPreview) return undefined;
    let cancel = false;
    const pump = async () => {
      while (!cancel) {
        if (exportingRef.current || previewBusy.current) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }
        const next = videosRef.current.find((item) => item.preview === undefined);
        if (!next) return;
        previewBusy.current = true;
        try {
          const frame = await VideoFlip.frameAt(next.uri, 0.3);
          if (cancel) {
            VideoFlip.removeTempFile(frame);
            return;
          }
          commitVideos((prev) => prev.map((it) => (it.id === next.id ? { ...it, preview: frame } : it)));
        } catch {
          if (cancel) return;
          commitVideos((prev) =>
            prev.map((it) => (it.id === next.id && it.preview === undefined ? { ...it, preview: '' } : it)),
          );
        } finally {
          previewBusy.current = false;
        }
      }
    };
    void pump();
    return () => {
      cancel = true;
    };
  }, [missingPreview]);

  const pickFromLibrary = async () => {
    if (busy) return;
    setPicking(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync(
        kind === 'video'
          ? {
              mediaTypes: ['videos'],
              allowsMultipleSelection: true,
              selectionLimit: 0,
              videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
              preferredAssetRepresentationMode:
                ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
            }
          : {
              mediaTypes: ['images'],
              allowsMultipleSelection: true,
              selectionLimit: 0,
            },
      );
      if (result.canceled) return;
      const next: MediaItem[] = [];
      result.assets.forEach((asset, index) => {
        const fallback = kind === 'video' ? `相册视频 ${index + 1}.mp4` : `相册图片 ${index + 1}.jpg`;
        const name = asset.fileName || baseName(asset.uri, fallback);
        if (kind === 'video' && asset.type && asset.type !== 'video' && !isVideo(name, asset.mimeType)) return;
        if (kind === 'image' && asset.type && asset.type !== 'image' && !isImage(name, asset.mimeType)) return;
        next.push({
          id: `${Date.now()}-${kind}-lib-${index}-${name}`,
          uri: asset.uri,
          name,
          size: asset.fileSize,
          durationMs: asset.duration ?? undefined,
          source: '相册',
          status: 'pending',
        });
      });
      addItems(next, kind);
    } catch (error) {
      Alert.alert('无法打开相册', errorText(error));
    } finally {
      setPicking(false);
    }
  };

  const pickFromFiles = async () => {
    if (busy) return;
    setPicking(true);
    setSummary('正在打开文件。放在 iCloud 里的视频要先下载，所以会比相册慢。');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: kind === 'video' ? ['video/*', 'public.movie', 'public.mpeg-4'] : ['image/*', 'public.image'],
        multiple: true,
        copyToCacheDirectory: false,
      });
      if (result.canceled) {
        setSummary('');
        return;
      }
      const next: MediaItem[] = [];
      result.assets.forEach((asset, index) => {
        const matched = kind === 'video' ? isVideo(asset.name, asset.mimeType) : isImage(asset.name, asset.mimeType);
        if (!matched) return;
        next.push({
          id: `${Date.now()}-${kind}-file-${index}-${asset.name}`,
          uri: asset.uri,
          name: asset.name,
          size: asset.size,
          source: '文件',
          status: 'pending',
        });
      });
      addItems(next, kind);
      setSummary('');
    } catch (error) {
      Alert.alert('无法打开文件', errorText(error));
    } finally {
      setPicking(false);
    }
  };

  const saveOriginal = async (item: MediaItem) => {
    if (savingOriginalId || item.originalSaved) return;
    setSavingOriginalId(item.id);
    savingOriginalRef.current = item.id;
    const allowed = await ensurePermission();
    if (!allowed) {
      savingOriginalRef.current = null;
      setSavingOriginalId(null);
      return;
    }
    let staged = '';
    try {
      staged = await VideoFlip.stageOriginal(item.uri);
      await MediaLibrary.createAssetAsync(staged);
      commitVideos((prev) => prev.map((it) => (it.id === item.id ? { ...it, originalSaved: true } : it)));
    } catch (error) {
      Alert.alert('原视频没有保存', errorText(error));
    } finally {
      if (staged) VideoFlip.removeTempFile(staged);
      savingOriginalRef.current = null;
      setSavingOriginalId(null);
    }
  };

  const ensurePermission = async () => {
    const current = await MediaLibrary.getPermissionsAsync(true);
    const permission = current.granted ? current : await MediaLibrary.requestPermissionsAsync(true);
    if (permission.granted) return true;
    Alert.alert('需要相册权限', '处理后的文件要保存到手机相册，请允许添加照片。', [
      { text: '取消', style: 'cancel' },
      { text: '去设置', onPress: () => void Linking.openSettings() },
    ]);
    return false;
  };

  const validateWatermark = () => {
    const marks =
      kind === 'video'
        ? videos.flatMap((item) => (item.watermark?.enabled ? [item.watermark] : []))
        : watermark.enabled
          ? [watermark]
          : [];
    if (marks.some((mark) => !mark.placeLeft && !mark.placeCenter)) {
      Alert.alert('请选择水印位置', '左边或中央至少打开一个。');
      return false;
    }
    return true;
  };

  const run = async () => {
    if (running || picking) return;
    if (kind === 'video') {
      commitVideos((prev) =>
        prev.map((it) =>
          it.status === 'failed' || it.status === 'cancelled'
            ? { ...it, status: 'pending', message: undefined, progress: 0, flipFallback: undefined }
            : it,
        ),
      );
    }
    const sourceItems = kind === 'video' ? videosRef.current : items;
    const queue = sourceItems.filter((item) => item.status !== 'saved');
    if (items.length === 0) {
      Alert.alert(kind === 'video' ? '还没有视频' : '还没有图片', '请先从相册或文件里选择。');
      return;
    }
    if (queue.length === 0) {
      Alert.alert('已经保存', '当前这些都已经保存到相册。');
      return;
    }
    if (Platform.OS !== 'ios') {
      Alert.alert('仅支持 iPhone', '处理并保存到相册目前只在 iPhone 安装包里可用。');
      return;
    }
    if (!validateWatermark()) return;
    const start = Number(clipStart);
    const end = Number(clipEnd);
    const freeze = Number(freezeSeconds);
    if (kind === 'video' && extendVideo && useCurrentClip) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(freeze) || end <= start || start < 0 || freeze < 0.5) {
        Alert.alert('请检查延长时间', '开始要小于结束，定格至少 0.5 秒。');
        return;
      }
      const tooShort = queue.find((item) => item.durationMs && item.durationMs > 0 && item.durationMs / 1000 + 0.08 < end);
      if (tooShort) {
        Alert.alert('视频不够长', `${tooShort.name} 短于结束时间 ${end} 秒，无法按这个时间延长。`);
        return;
      }
    }
    if (kind === 'video' && followOn && !followClip) {
      Alert.alert('还没有关注片段', '请先上传末尾要接上的视频，或关掉这个开关。');
      return;
    }
    if (kind === 'video') {
      const invalidCut = queue.find((item) => {
        if (item.flip === false || !item.cut) return false;
        const start = Number(item.cut.start);
        const end = Number(item.cut.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start + 0.04) return true;
        if (item.durationMs && item.durationMs > 0) {
          const seconds = item.durationMs / 1000;
          if (start >= seconds - 0.04) return true;
          if (seconds - (Math.min(end, seconds) - start) <= 0.2) return true;
        }
        return false;
      });
      if (invalidCut) {
        Alert.alert('请检查移除时间', `${invalidCut.name} 的开始要小于结束，并且不能把整段都剪掉。`);
        return;
      }
    }
    if (kind === 'image' && !flipImages && !watermark.enabled && !crop) {
      Alert.alert('还没有处理项', '请勾选水平翻转、水印，或先设置裁剪。');
      return;
    }
    const allowed = await ensurePermission();
    if (!allowed) return;

    const heavy =
      kind === 'video' &&
      (extendVideo ||
        followOn ||
        zoom > 1 ||
        queue.some(
          (item) =>
            (item.subtitle ?? '').trim().length > 0 || Boolean(item.filter) || Boolean(item.watermark?.enabled),
        ));

    setRunning(true);
    runningRef.current = true;
    setSummary('');
    let saved = 0;
    let failed = 0;
    let cancelled = 0;
    const saveNext = createSaveQueue();
    const mark = watermarkPayload(watermark);
    const stopped = (error: unknown) => {
      const text = errorText(error);
      return stopRef.current || text.includes('已取消') || text.includes('已停止');
    };

    if (kind === 'video') {
      stopRef.current = false;
      cancelledRef.current = new Set();
      VideoFlip.prepareFlipBatch();
      while (!stopRef.current) {
        const item = videosRef.current.find((it) => it.status === 'pending' && !cancelledRef.current.has(it.id));
        if (!item) break;
        commitVideos((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, status: 'processing', message: '正在转换…', progress: 0.01 } : it,
          ),
        );
        let lastProgress = -1;
        let lastMove = Date.now();
        const timer = setInterval(() => {
          const value = VideoFlip.flipProgress(item.id);
          if (Math.abs(value - lastProgress) > 0.002) {
            lastProgress = value;
            lastMove = Date.now();
          }
          const moved = lastProgress > 0.03;
          const stalled = Date.now() - lastMove > (moved ? 12000 : 20000);
          commitVideos((prev) =>
            prev.map((it) => {
              if (it.id !== item.id || it.status !== 'processing') return it;
              return {
                ...it,
                progress: value,
                message: stalled
                  ? '进度停住了。可以取消这一条，再把原视频保存到相册，后面的会继续。'
                  : it.message?.startsWith('进度停住了')
                    ? '正在转换…'
                    : it.message,
              };
            }),
          );
        }, 500);
        let outputUri = '';
        let holdOriginal = false;
        let fallbackReason = '';
        let keepStraight = false;
        const withExport = async <T,>(job: () => Promise<T>) => {
          const deadline = Date.now() + 8000;
          while (
            previewBusy.current &&
            !stopRef.current &&
            !cancelledRef.current.has(item.id) &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          if (stopRef.current || cancelledRef.current.has(item.id)) {
            throw new Error('翻转已取消');
          }
          exportingRef.current = true;
          try {
            return await job();
          } finally {
            exportingRef.current = false;
          }
        };
        try {
          const current = videosRef.current.find((it) => it.id === item.id);
          if (current && current.preview === undefined && !previewBusy.current) {
            previewBusy.current = true;
            try {
              const frame = await VideoFlip.frameAt(current.uri, 0.3);
              if (stopRef.current || cancelledRef.current.has(item.id)) {
                VideoFlip.removeTempFile(frame);
                throw new Error('翻转已取消');
              }
              commitVideos((prev) => prev.map((it) => (it.id === item.id ? { ...it, preview: frame } : it)));
            } catch (error) {
              if (stopRef.current || cancelledRef.current.has(item.id) || errorText(error).includes('已取消')) {
                throw error;
              }
              commitVideos((prev) =>
                prev.map((it) => (it.id === item.id && it.preview === undefined ? { ...it, preview: '' } : it)),
              );
            } finally {
              previewBusy.current = false;
            }
          }
          const keepStraightNow = (videosRef.current.find((it) => it.id === item.id) ?? item).flip === false;
          keepStraight = keepStraightNow;
          if (keepStraightNow) {
            clearInterval(timer);
            if (stopRef.current || cancelledRef.current.has(item.id)) {
              throw new Error('翻转已取消');
            }
            commitVideos((prev) =>
              prev.map((it) =>
                it.id === item.id ? { ...it, status: 'processing', message: '不翻转，正在保存原视频…', progress: 0.4 } : it,
              ),
            );
            outputUri = await withNative(() => VideoFlip.stageOriginal(item.uri));
            if (stopRef.current || cancelledRef.current.has(item.id)) {
              throw new Error('翻转已取消');
            }
            commitVideos((prev) =>
              prev.map((it) =>
                it.id === item.id ? { ...it, status: 'saving', message: '正在保存到相册…', progress: 0.9 } : it,
              ),
            );
            await saveNext(async () => {
              await MediaLibrary.createAssetAsync(outputUri);
            });
            if (stopRef.current || cancelledRef.current.has(item.id)) {
              throw new Error('翻转已取消');
            }
            saved += 1;
            commitVideos((prev) =>
              prev.map((it) =>
                it.id === item.id ? { ...it, status: 'saved', progress: 1, flipFallback: undefined, message: '已把原视频保存到相册' } : it,
              ),
            );
          } else {
          outputUri = await withExport(() =>
            withNative(() =>
              abandonIfStopped(item.id, () =>
                VideoFlip.flipHorizontal(item.uri, {
                jobId: item.id,
                watermark: watermarkPayload(item.watermark ?? defaultWatermark),
                zoom,
                subtitle: item.subtitle?.trim() || undefined,
                extend:
                  extendVideo && useCurrentClip
                    ? {
                        start: Number(clipStart),
                        end: Number(clipEnd),
                        freeze: Number(freezeSeconds),
                        mode: highlightMode,
                      }
                    : undefined,
                filter: item.filter,
                ...(item.cut ? { cut: { start: Number(item.cut.start), end: Number(item.cut.end) } } : {}),
                }),
              ),
            ),
          );
          if (stopRef.current || cancelledRef.current.has(item.id)) {
            throw new Error('翻转已取消');
          }
          if (followOn && followClip) {
            const joined = await withExport(() => withNative(() => VideoFlip.joinVideos([outputUri, followClip.uri])));
            VideoFlip.removeTempFile(outputUri);
            outputUri = joined;
          }
          clearInterval(timer);
          commitVideos((prev) =>
            prev.map((it) =>
              it.id === item.id ? { ...it, status: 'saving', message: '正在保存到相册…', progress: 0.98 } : it,
            ),
          );
          await saveNext(async () => {
            await MediaLibrary.createAssetAsync(outputUri);
          });
          if (stopRef.current || cancelledRef.current.has(item.id)) {
            throw new Error('翻转已取消');
          }
          const notes: string[] = [];
          const missed: string[] = [];
          if (item.sampleFrames && outputUri) {
            let frames: string[] = [];
            try {
              commitVideos((prev) =>
                prev.map((it) => (it.id === item.id ? { ...it, message: '正在抽这一条的画面…' } : it)),
              );
              frames = await withExport(() => withNative(() => VideoFlip.sampleFrames(outputUri, 4)));
              await saveNext(async () => {
                for (const frame of frames) {
                  await MediaLibrary.createAssetAsync(frame);
                }
              });
              notes.push(`另存 ${frames.length} 张抽帧图片`);
            } catch {
              missed.push('抽帧');
            } finally {
              frames.forEach((frame) => VideoFlip.removeTempFile(frame));
            }
          }
          if (item.cover && outputUri && !cancelledRef.current.has(item.id) && !stopRef.current) {
            let coverUri = '';
            try {
              commitVideos((prev) =>
                prev.map((it) => (it.id === item.id ? { ...it, message: '正在做这一条的封面…' } : it)),
              );
              coverUri = await withExport(() => withNative(() => VideoFlip.makeCover(outputUri, item.coverText?.trim() ?? '')));
              await saveNext(async () => {
                await MediaLibrary.createAssetAsync(coverUri);
              });
              notes.push('另存 1 张封面');
            } catch {
              missed.push('封面');
            } finally {
              if (coverUri) VideoFlip.removeTempFile(coverUri);
            }
          }
          saved += 1;
          const savedNote = notes.length > 0 ? `，${notes.join('，')}` : '';
          const missedNote = missed.length > 0 ? `。视频已保存，这一条${missed.join('和')}没有成功` : '';
          commitVideos((prev) =>
            prev.map((it) =>
              it.id === item.id
                ? { ...it, status: 'saved', progress: 1, flipFallback: undefined, message: `已保存到相册${savedNote}${missedNote}` }
                : it,
            ),
          );
          }
        } catch (error) {
          if (stopped(error) || cancelledRef.current.has(item.id)) {
            const text = errorText(error);
            if (text.includes('长时间没有进展')) {
              holdOriginal = !stopRef.current;
              fallbackReason = text;
              commitVideos((prev) =>
                prev.map((it) =>
                  it.id === item.id
                    ? { ...it, status: 'saving', progress: 0.9, message: '翻转没有成功，正在自动保存原视频…' }
                    : it,
                ),
              );
            } else {
              cancelled += 1;
              commitVideos((prev) =>
                prev.map((it) =>
                  it.id === item.id
                    ? { ...it, status: 'cancelled', progress: 0, message: '已取消。可以保存原视频，后面的会继续转换。' }
                    : it,
                ),
              );
            }
          } else if (keepStraight) {
            failed += 1;
            commitVideos((prev) =>
              prev.map((it) =>
                it.id === item.id
                  ? { ...it, status: 'failed', progress: 0, message: `原视频没有保存。${errorText(error)}` }
                  : it,
              ),
            );
          } else {
            holdOriginal = !stopRef.current;
            fallbackReason = errorText(error);
            commitVideos((prev) =>
              prev.map((it) =>
                it.id === item.id
                  ? { ...it, status: 'saving', progress: 0.9, message: '翻转没有成功，正在自动保存原视频…' }
                  : it,
              ),
            );
          }
        } finally {
          clearInterval(timer);
          if (outputUri) VideoFlip.removeTempFile(outputUri);
        }
        if (!stopRef.current && holdOriginal && !cancelledRef.current.has(item.id)) {
          const reason = fallbackReason || '翻转没有成功';
          let staged = '';
          try {
            staged = await VideoFlip.stageOriginal(item.uri);
            if (stopRef.current || cancelledRef.current.has(item.id)) {
              throw new Error('翻转已取消');
            }
            await saveNext(async () => {
              await MediaLibrary.createAssetAsync(staged);
            });
            saved += 1;
            setPreviewOpen((prev) => ({ ...prev, [item.id]: true }));
            commitVideos((prev) =>
              prev.map((it) =>
                it.id === item.id
                  ? {
                      ...it,
                      status: 'saved',
                      progress: 1,
                      originalSaved: true,
                      flipFallback: true,
                      message: `翻转失败，已自动保存原视频。原因：${reason}`,
                    }
                  : it,
              ),
            );
          } catch (error) {
            if (stopRef.current || cancelledRef.current.has(item.id) || errorText(error).includes('已取消')) {
              cancelled += 1;
              commitVideos((prev) =>
                prev.map((it) =>
                  it.id === item.id
                    ? { ...it, status: 'cancelled', progress: 0, message: '已取消。可以保存原视频，后面的会继续转换。' }
                    : it,
                ),
              );
            } else {
              failed += 1;
              setPreviewOpen((prev) => ({ ...prev, [item.id]: true }));
              commitVideos((prev) =>
                prev.map((it) =>
                  it.id === item.id
                    ? {
                        ...it,
                        status: 'failed',
                        progress: 0,
                        flipFallback: true,
                        message: `翻转失败，原视频也没有保存成功。原因：${reason}。${errorText(error)}`,
                      }
                    : it,
                ),
              );
            }
          } finally {
            if (staged) VideoFlip.removeTempFile(staged);
          }
        }
        if (!stopRef.current && cancelledRef.current.has(item.id)) {
          const started = Date.now();
          while (!stopRef.current && Date.now() - started < 800 && savingOriginalRef.current !== item.id) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          while (!stopRef.current && savingOriginalRef.current === item.id && Date.now() - started < 20000) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
      }
    } else {
      await runWithLimit(queue, heavy ? 1 : 2, async (item) => {
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'processing', message: '正在处理…' } : it)),
        );
        let outputUri = '';
        try {
          outputUri = await VideoFlip.processImage(item.uri, {
            flip: flipImages,
            crop: crop ?? undefined,
            watermark: mark,
          });
          setItems((prev) =>
            prev.map((it) => (it.id === item.id ? { ...it, status: 'saving', message: '正在保存到相册…' } : it)),
          );
          await saveNext(async () => {
            await MediaLibrary.createAssetAsync(outputUri);
          });
          saved += 1;
          setItems((prev) =>
            prev.map((it) => (it.id === item.id ? { ...it, status: 'saved', message: '已保存到相册' } : it)),
          );
        } catch (error) {
          failed += 1;
          setItems((prev) =>
            prev.map((it) => (it.id === item.id ? { ...it, status: 'failed', message: errorText(error) } : it)),
          );
        } finally {
          if (outputUri) VideoFlip.removeTempFile(outputUri);
        }
      });
    }

    const text =
      cancelled > 0
        ? `保存 ${saved} 个，失败 ${failed} 个，取消 ${cancelled} 个。没完成的可以再转，也可以先把原视频存进相册。`
        : failed === 0
          ? `已把 ${saved} 个保存到相册`
          : `成功 ${saved} 个，失败 ${failed} 个。失败的可以再点一次重试`;
    setSummary(text);
    runningRef.current = false;
    setRunning(false);
    if (!stopRef.current) {
      Alert.alert(failed === 0 && cancelled === 0 ? '已保存' : '处理结束', text);
    }
  };

  const cancelItem = (id: string) => {
    cancelledRef.current.add(id);
    VideoFlip.cancelFlip(id);
    if (activeAbort.current?.id === id) activeAbort.current.abort();
    commitVideos((prev) =>
      prev.map((it) =>
        it.id === id && it.status !== 'saved'
          ? { ...it, status: 'cancelled', progress: 0, message: '已取消。可以保存原视频，后面的会继续转换。' }
          : it,
      ),
    );
  };

  const stopAll = () => {
    stopRef.current = true;
    VideoFlip.cancelAllFlips();
    activeAbort.current?.abort();
    commitVideos((prev) =>
      prev.map((it) => {
        if (it.status !== 'pending' && it.status !== 'processing' && it.status !== 'saving') return it;
        cancelledRef.current.add(it.id);
        return { ...it, status: 'cancelled', progress: 0, message: '已取消，可以保存原视频或重新转换' };
      }),
    );
  };

  const abandonIfStopped = <T,>(id: string, job: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        if (activeAbort.current?.abort === abort) activeAbort.current = null;
        if (error) reject(error instanceof Error ? error : new Error(errorText(error)));
        else resolve(value as T);
      };
      const abort = () => {
        VideoFlip.cancelFlip(id);
        finish(new Error('翻转已取消'));
      };
      activeAbort.current = { id, abort };
      const watch = setInterval(() => {
        if (stopRef.current || cancelledRef.current.has(id)) abort();
      }, 200);
      job().then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });

  const pendingCount = items.filter((item) => item.status !== 'saved').length;

  const refreshVideo = () => {
    if (running || picking) return;
    setKind('video');
    commitVideos([]);
    setWatermark(defaultWatermark);
    setBatchWatermark(false);
    setZoom(1);
    setUseCurrentClip(true);
    setExtendVideo(false);
    setClipStart('3');
    setClipEnd('6');
    setFreezeSeconds('6');
    setHighlightMode('normal');
    setFollowOn(false);
    setFollowClip(null);
    setPreviewList('default');
    setSummary('');
  };

  const pickFollow = async (from: 'library' | 'files') => {
    if (busy) return;
    setPicking(true);
    try {
      if (from === 'library') {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['videos'],
          allowsMultipleSelection: false,
          videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
          preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
        });
        if (result.canceled || !result.assets[0]) return;
        const asset = result.assets[0];
        const name = asset.fileName || baseName(asset.uri, '关注片段.mp4');
        setFollowClip({ uri: asset.uri, name });
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: ['video/*', 'public.movie', 'public.mpeg-4'],
          multiple: false,
          copyToCacheDirectory: false,
        });
        if (result.canceled || !result.assets[0]) return;
        const asset = result.assets[0];
        if (!isVideo(asset.name, asset.mimeType)) {
          Alert.alert('不是视频', '请选择一个视频片段。');
          return;
        }
        setFollowClip({ uri: asset.uri, name: asset.name });
      }
    } catch (error) {
      Alert.alert('无法选择片段', errorText(error));
    } finally {
      setPicking(false);
    }
  };

  if (smearOpen) {
    return <SmearScreen onClose={() => setSmearOpen(false)} />;
  }

  if (faceOpen) {
    return <FaceCoverScreen onClose={() => setFaceOpen(false)} />;
  }

  if (mergeOpen) {
    return <MergeScreen onClose={() => setMergeOpen(false)} />;
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{kind === 'video' ? '视频处理' : '图片处理'}</Text>
        {kind === 'video' ? (
          <View style={styles.titleActions}>
            <Pressable disabled={running || picking} onPress={refreshVideo} hitSlop={8}>
              <Text style={styles.link}>刷新</Text>
            </Pressable>
            <Pressable disabled={running || picking} onPress={() => setSmearOpen(true)} hitSlop={8}>
              <Text style={styles.link}>去水印</Text>
            </Pressable>
            <Pressable disabled={running || picking} onPress={() => setFaceOpen(true)} hitSlop={8}>
              <Text style={styles.link}>遮脸</Text>
            </Pressable>
            <Pressable disabled={running || picking} onPress={() => setMergeOpen(true)} hitSlop={8}>
              <Text style={styles.link}>合并</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <Text style={styles.subtitle}>
        {kind === 'video'
          ? '可多选视频，一键左右镜像。每条视频单独设置字幕、滤镜、水印、抽帧和封面。'
          : '可多选图片。翻转、水印和裁剪会一起应用到全部，并保存到相册。'}
      </Text>
      <View style={styles.segment}>
        <Pressable style={[styles.segmentItem, kind === 'video' && styles.segmentOn]} onPress={() => setKind('video')}>
          <Text style={[styles.segmentText, kind === 'video' && styles.onAccentText]}>视频</Text>
        </Pressable>
        <Pressable style={[styles.segmentItem, kind === 'image' && styles.segmentOn]} onPress={() => setKind('image')}>
          <Text style={[styles.segmentText, kind === 'image' && styles.onAccentText]}>图片</Text>
        </Pressable>
      </View>
      {kind === 'video' ? (
        <View style={styles.previewSwitch}>
          {(
            [
              ['default', '默认'],
              ['all', '全部预览'],
              ['original', '原视频'],
              ['current', '正在处理'],
            ] as const
          ).map(([mode, label]) => (
            <Pressable
              key={mode}
              style={[styles.zoomChip, previewList === mode && styles.zoomChipOn, previewList === mode && { backgroundColor: accent }]}
              onPress={() => setPreviewList(mode)}
            >
              <Text style={[styles.zoomText, previewList === mode && styles.onAccentText]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {kind === 'video' ? (
          <View style={styles.optionCard}>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>统一水印</Text>
              <Switch
                value={batchWatermark}
                onValueChange={(enabled) => {
                  setBatchWatermark(enabled);
                  commitVideos((prev) =>
                    prev.map((it) => ({
                      ...it,
                      watermark: {
                        ...(it.watermark ?? defaultWatermark),
                        enabled,
                        placeLeft: true,
                        placeCenter: false,
                      },
                    })),
                  );
                }}
                trackColor={{ false: palette.switchOff, true: accent }}
              />
            </View>
            <Text style={styles.optionHint}>打开后，这次选中的视频都加水印，位置在旁边。关掉则这次都不加。</Text>
            <Text style={styles.optionLabel}>放大倍数</Text>
            <View style={styles.zoomRow}>
              {[1, 1.1, 1.2].map((value) => (
                <Pressable
                  key={value}
                  style={[styles.zoomChip, zoom === value && styles.zoomChipOn, zoom === value && { backgroundColor: accent }]}
                  onPress={() => setZoom(value)}
                >
                  <Text style={[styles.zoomText, zoom === value && styles.onAccentText]}>{value === 1 ? '不放大' : `${value}`}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.optionHint}>
              字幕、滤镜、水印、移除片段、抽帧和封面都在每条视频下面单独设置。不填写或不勾选的那一条不会做这项处理。有字幕的会用系统中文男声解说，原声在解说期间变小。
            </Text>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>延长视频</Text>
              <Switch
                value={extendVideo}
                onValueChange={setExtendVideo}
                trackColor={{ false: palette.switchOff, true: accent }}
              />
            </View>
            {extendVideo ? (
              <View style={styles.extendBox}>
                <View style={styles.optionRow}>
                  <Text style={styles.optionLabel}>当前视频</Text>
                  <Switch
                    value={useCurrentClip}
                    onValueChange={setUseCurrentClip}
                    trackColor={{ false: palette.switchOff, true: accent }}
                  />
                </View>
                <View style={styles.timeRow}>
                  <Text style={styles.optionHint}>开始</Text>
                  <TextInput value={clipStart} onChangeText={setClipStart} keyboardType="decimal-pad" style={styles.timeInput} />
                  <Text style={styles.optionHint}>结束</Text>
                  <TextInput value={clipEnd} onChangeText={setClipEnd} keyboardType="decimal-pad" style={styles.timeInput} />
                  <Text style={styles.optionHint}>定格</Text>
                  <TextInput value={freezeSeconds} onChangeText={setFreezeSeconds} keyboardType="decimal-pad" style={styles.timeInput} />
                </View>
                <View style={styles.zoomRow}>
                  {(
                    [
                      ['normal', '正常'],
                      ['slow', '慢速'],
                      ['slowZoom', '慢速放大'],
                    ] as const
                  ).map(([mode, label]) => (
                    <Pressable
                      key={mode}
                      style={[styles.zoomChip, highlightMode === mode && styles.zoomChipOn, highlightMode === mode && { backgroundColor: accent }]}
                      onPress={() => setHighlightMode(mode)}
                    >
                      <Text style={[styles.zoomText, highlightMode === mode && styles.onAccentText]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.optionHint}>
                  先播到片段结束，定格后再插入这一段。慢速只拉长画面。视频短于结束时间时，这一条会失败。
                </Text>
              </View>
            ) : null}
            <Text style={styles.optionHint}>这些开关默认关闭。不勾选时只做翻转和放大。</Text>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>末尾关注</Text>
              <Switch
                value={followOn}
                onValueChange={setFollowOn}
                trackColor={{ false: palette.switchOff, true: accent }}
              />
            </View>
            {followOn ? (
              <View style={styles.extendBox}>
                <View style={styles.actions}>
                  <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFollow('library')}>
                    <Text style={styles.secondaryText}>相册片段</Text>
                  </Pressable>
                  <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFollow('files')}>
                    <Text style={styles.secondaryText}>文件片段</Text>
                  </Pressable>
                </View>
                <Text style={styles.optionHint}>
                  {followClip
                    ? `将接到每个视频末尾：${followClip.name}`
                    : '上传一段关注视频。它不会被翻转，处理完后接到每一条的末尾。'}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {kind === 'image' ? <WatermarkForm value={watermark} onChange={setWatermark} /> : null}
        {kind === 'image' ? (
          <View style={styles.optionCard}>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>水平翻转</Text>
              <Switch
                value={flipImages}
                onValueChange={setFlipImages}
                trackColor={{ false: palette.switchOff, true: accent }}
              />
            </View>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>{crop ? '已设置裁剪' : '未设置裁剪'}</Text>
              <Pressable
                disabled={!sample || busy}
                onPress={() => {
                  if (!sample) {
                    Alert.alert('还没有图片', '请先选择要裁剪的图片。');
                    return;
                  }
                  setCropOpen(true);
                }}
              >
                <Text style={styles.link}>{sample ? '设置裁剪' : '先选图片'}</Text>
              </Pressable>
            </View>
            {crop ? (
              <Pressable onPress={() => setCrop(null)}>
                <Text style={styles.link}>清除裁剪</Text>
              </Pressable>
            ) : (
              <Text style={styles.optionHint}>裁剪以样板图的比例为准，其他已选图片一起修改。</Text>
            )}
          </View>
        ) : null}
        <View style={styles.actions}>
          <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFromLibrary()}>
            <Text style={styles.secondaryText}>从相册选择</Text>
          </Pressable>
          <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFromFiles()}>
            <Text style={styles.secondaryText}>从文件选择</Text>
          </Pressable>
        </View>
        <View style={styles.listHead}>
          <Text style={styles.listTitle}>已选 {items.length} 个</Text>
          {items.length > 0 && !running && !picking ? (
            <Pressable
              onPress={() => {
                if (kind === 'video') {
                  videosRef.current.forEach((item) => {
                    if (item.preview) VideoFlip.removeTempFile(item.preview);
                  });
                  commitVideos([]);
                } else {
                  setItems([]);
                  setCropSampleId(null);
                }
              }}
            >
              <Text style={styles.link}>清空</Text>
            </Pressable>
          ) : null}
        </View>
        {items.length === 0 ? (
          <Text style={styles.empty}>还没有文件。可以一次多选。</Text>
        ) : (
          (() => {
            const listed =
              kind !== 'video' || previewList === 'default' || previewList === 'all'
                ? items
                : previewList === 'original'
                  ? items.filter(isOriginalPreview)
                  : items.filter((item) => item.status === 'processing' || item.status === 'saving');
            const forcePreview = kind === 'video' && previewList !== 'default';
            return (
              <>
                {listed.length === 0 ? (
                  <Text style={styles.empty}>
                    {previewList === 'original' ? '还没有改存或直接保存的原视频。' : '当前没有正在处理的视频。'}
                  </Text>
                ) : null}
                {listed.map((item) => {
            const index = Math.max(0, items.findIndex((it) => it.id === item.id));
            const meta = [item.source, formatDuration(item.durationMs), formatSize(item.size)].filter(Boolean).join(' · ');
            const isSample = kind === 'image' && sample?.id === item.id;
            const flipFallback = kind === 'video' && item.flipFallback === true;
            const savedFolded =
              kind === 'video' && item.status === 'saved' && !flipFallback && !forcePreview && openSaved[item.id] !== true;
            if (savedFolded) {
              return (
                <View key={item.id} style={styles.card}>
                  <View style={styles.compactRow}>
                    <Text style={styles.cardName} numberOfLines={1}>
                      {index + 1}. {item.name} · 已保存
                    </Text>
                    <Pressable onPress={() => setOpenSaved((prev) => ({ ...prev, [item.id]: true }))} hitSlop={8}>
                      <Text style={styles.link}>展开</Text>
                    </Pressable>
                  </View>
                </View>
              );
            }
            const showPreview =
              kind === 'video' &&
              Boolean(item.preview) &&
              (forcePreview || flipFallback || (previewOpen[item.id] ?? (item.status === 'processing' || item.status === 'saving')));
            const active = item.status === 'processing' || item.status === 'saving';
            return (
              <View key={item.id} style={styles.card}>
                <View style={styles.cardBody}>
                  <Text style={styles.cardName} numberOfLines={2}>
                    {index + 1}. {item.name}
                    {isSample ? ' · 样板' : ''}
                  </Text>
                  {meta ? <Text style={styles.cardMeta}>{meta}</Text> : null}
                  {kind === 'video' ? (
                    <View style={styles.compactRow}>
                      {item.preview && !forcePreview ? (
                        <Pressable
                          onPress={() => setPreviewOpen((prev) => ({ ...prev, [item.id]: !showPreview }))}
                          hitSlop={8}
                        >
                          <Text style={styles.link}>{showPreview ? '收起预览' : '预览'}</Text>
                        </Pressable>
                      ) : !item.preview ? (
                        <Text style={styles.cardMeta}>{item.preview === undefined ? '正在读取预览…' : '没有预览'}</Text>
                      ) : null}
                      {item.status === 'pending' || item.status === 'processing' || item.status === 'failed' ? (
                        <Pressable onPress={() => cancelItem(item.id)} hitSlop={8}>
                          <Text style={styles.link}>{item.status === 'failed' ? '跳过这条' : '取消这条'}</Text>
                        </Pressable>
                      ) : null}
                      {item.status === 'saved' && !flipFallback && !forcePreview ? (
                        <Pressable onPress={() => setOpenSaved((prev) => ({ ...prev, [item.id]: false }))} hitSlop={8}>
                          <Text style={styles.link}>收起</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                  {showPreview && item.preview ? (
                    <Image source={{ uri: item.preview }} style={styles.preview} resizeMode="cover" />
                  ) : null}
                  {flipFallback ? (
                    <Text style={styles.bad}>
                      {item.status === 'saved'
                        ? '这一条翻转失败，已自动改存原视频。上面的预览是原视频，不是翻转后的成片。'
                        : '这一条翻转失败，原视频没能自动保存。上面的预览仍是原视频，不是翻转后的成片。'}
                    </Text>
                  ) : null}
                  {active ? (
                    <View style={styles.track}>
                      <View style={[styles.bar, { width: `${Math.max(4, Math.round((item.progress ?? 0) * 100))}%` }]} />
                    </View>
                  ) : null}
                  {kind === 'video' && previewList === 'default' ? (
                    <>
                      <View style={styles.optionRow}>
                        <Text style={styles.optionLabel}>水平翻转</Text>
                        <Switch
                          disabled={busy}
                          value={item.flip !== false}
                          onValueChange={(enabled) =>
                            commitVideos((prev) =>
                              prev.map((it) => (it.id === item.id ? { ...it, flip: enabled } : it)),
                            )
                          }
                          trackColor={{ false: palette.switchOff, true: accent }}
                        />
                      </View>
                      <Text style={styles.optionHint}>
                        默认翻转。关掉后这一条不翻转，直接把原视频存进相册，字幕、水印、剪辑和封面都不会做。
                      </Text>
                      <TextInput
                        value={item.subtitle ?? ''}
                        onChangeText={(text) =>
                          commitVideos((prev) => prev.map((it) => (it.id === item.id ? { ...it, subtitle: text } : it)))
                        }
                        editable={!busy}
                        placeholder="给这条视频加字幕，留空则不加"
                        placeholderTextColor={palette.placeholder}
                        multiline
                        style={styles.itemScript}
                      />
                      <Text style={styles.cardMeta}>滤镜</Text>
                      <View style={styles.zoomRow}>
                        {FILTERS.map(([name, label]) => {
                          const selected = (item.filter ?? '') === name;
                          return (
                            <Pressable
                              key={label}
                              disabled={busy}
                              style={[styles.zoomChip, selected && styles.zoomChipOn, selected && { backgroundColor: accent }]}
                              onPress={() =>
                                commitVideos((prev) =>
                                  prev.map((it) =>
                                    it.id === item.id ? { ...it, filter: name === '' ? undefined : name } : it,
                                  ),
                                )
                              }
                            >
                              <Text style={[styles.zoomText, selected && styles.onAccentText]}>{label}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                      <WatermarkForm
                        embedded
                        disabled={busy}
                        value={item.watermark ?? defaultWatermark}
                        onChange={(next) =>
                          commitVideos((prev) => prev.map((it) => (it.id === item.id ? { ...it, watermark: next } : it)))
                        }
                      />
                      <View style={styles.optionRow}>
                        <Text style={styles.optionLabel}>移除片段</Text>
                        <Switch
                          disabled={busy}
                          value={item.cut != null}
                          onValueChange={(enabled) =>
                            commitVideos((prev) =>
                              prev.map((it) =>
                                it.id === item.id ? { ...it, cut: enabled ? { start: '', end: '' } : undefined } : it,
                              ),
                            )
                          }
                          trackColor={{ false: palette.switchOff, true: accent }}
                        />
                      </View>
                      {item.cut ? (
                        <>
                          <View style={styles.timeRow}>
                            <Text style={styles.optionHint}>开始</Text>
                            <TextInput
                              value={item.cut.start}
                              onChangeText={(text) =>
                                commitVideos((prev) =>
                                  prev.map((it) =>
                                    it.id === item.id && it.cut ? { ...it, cut: { ...it.cut, start: text } } : it,
                                  ),
                                )
                              }
                              editable={!busy}
                              keyboardType="decimal-pad"
                              placeholder="0"
                              placeholderTextColor={palette.placeholder}
                              style={styles.timeInput}
                            />
                            <Text style={styles.optionHint}>结束</Text>
                            <TextInput
                              value={item.cut.end}
                              onChangeText={(text) =>
                                commitVideos((prev) =>
                                  prev.map((it) =>
                                    it.id === item.id && it.cut ? { ...it, cut: { ...it.cut, end: text } } : it,
                                  ),
                                )
                              }
                              editable={!busy}
                              keyboardType="decimal-pad"
                              placeholder="1"
                              placeholderTextColor={palette.placeholder}
                              style={styles.timeInput}
                            />
                            <Text style={styles.optionHint}>秒</Text>
                          </View>
                          <Text style={styles.optionHint}>
                            只剪掉这一条里的这一段，后面的画面往前接。关掉开关则不剪。
                          </Text>
                        </>
                      ) : null}
                      <View style={styles.optionRow}>
                        <Text style={styles.optionLabel}>随机抽帧</Text>
                        <Switch
                          disabled={busy}
                          value={item.sampleFrames === true}
                          onValueChange={(enabled) =>
                            commitVideos((prev) =>
                              prev.map((it) => (it.id === item.id ? { ...it, sampleFrames: enabled } : it)),
                            )
                          }
                          trackColor={{ false: palette.switchOff, true: accent }}
                        />
                      </View>
                      {item.sampleFrames ? (
                        <Text style={styles.optionHint}>
                          只对这一条。翻转保存成功后，从成片随机再存 4 张图片。关掉则不抽。
                        </Text>
                      ) : null}
                      <View style={styles.optionRow}>
                        <Text style={styles.optionLabel}>封面</Text>
                        <Switch
                          disabled={busy}
                          value={item.cover === true}
                          onValueChange={(enabled) =>
                            commitVideos((prev) =>
                              prev.map((it) => (it.id === item.id ? { ...it, cover: enabled } : it)),
                            )
                          }
                          trackColor={{ false: palette.switchOff, true: accent }}
                        />
                      </View>
                      {item.cover ? (
                        <>
                          <TextInput
                            value={item.coverText ?? ''}
                            onChangeText={(text) =>
                              commitVideos((prev) => prev.map((it) => (it.id === item.id ? { ...it, coverText: text } : it)))
                            }
                            editable={!busy}
                            placeholder="封面文字，可不填"
                            placeholderTextColor={palette.placeholder}
                            multiline
                            style={styles.itemScript}
                          />
                          <Text style={styles.optionHint}>
                            只对这一条。保存后从成片里挑一张更清楚的高光做封面。横屏视频出横图，竖屏视频出竖图。填了文字会压成黄字黑边的封面大字。
                          </Text>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {item.message ? (
                    <Text
                      style={[
                        styles.cardStatus,
                        item.status === 'saved' && !item.flipFallback && styles.ok,
                        (item.status === 'failed' || item.flipFallback) && styles.bad,
                      ]}
                    >
                      {item.message}
                    </Text>
                  ) : null}
                  {kind === 'video' && canKeepOriginal(item) ? (
                    <Pressable
                      disabled={savingOriginalId != null || item.originalSaved}
                      onPress={() => void saveOriginal(item)}
                      style={[styles.keepOriginal, (savingOriginalId != null || item.originalSaved) && styles.primaryDisabled]}
                    >
                      <Text style={styles.keepOriginalText}>
                        {item.originalSaved
                          ? '原视频已保存到相册'
                          : savingOriginalId === item.id
                            ? '正在保存原视频…'
                            : '原视频保存到相册'}
                      </Text>
                    </Pressable>
                  ) : null}
                  {kind === 'image' && !busy ? (
                    <Pressable
                      onPress={() => {
                        setCropSampleId(item.id);
                        setCropOpen(true);
                      }}
                    >
                      <Text style={styles.link}>用这张设置裁剪</Text>
                    </Pressable>
                  ) : null}
                </View>
                {item.status !== 'processing' && item.status !== 'saving' ? (
                  <Pressable
                    onPress={() => {
                      if (item.preview) VideoFlip.removeTempFile(item.preview);
                      if (kind === 'video') {
                        commitVideos((prev) => prev.filter((it) => it.id !== item.id));
                      } else {
                        setItems((prev) => prev.filter((it) => it.id !== item.id));
                        if (cropSampleId === item.id) setCropSampleId(null);
                      }
                    }}
                    hitSlop={10}
                  >
                    <Text style={styles.remove}>移除</Text>
                  </Pressable>
                ) : null}
              </View>
            );
                })}
              </>
            );
          })()
        )}
      </ScrollView>
      {summary ? <Text style={styles.summary}>{summary}</Text> : null}
      <View style={styles.footer}>
        {running && kind === 'video' ? (
          <Pressable style={[styles.primary, { backgroundColor: accent }]} onPress={stopAll}>
            <Text style={styles.primaryText}>全部停止</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.primary, { backgroundColor: accent }, (picking || pendingCount === 0) && styles.primaryDisabled]}
            disabled={picking || pendingCount === 0}
            onPress={() => void run()}
          >
            {picking ? (
              <ActivityIndicator color="#F4F7FB" />
            ) : (
              <Text style={styles.primaryText}>
                {kind === 'video' ? `一键水平翻转并保存（${pendingCount}）` : `处理并保存（${pendingCount}）`}
              </Text>
            )}
          </Pressable>
        )}
        <Text style={styles.footerHint}>
          {picking
            ? '正在读取…'
            : running
              ? '一次转一条，其余排队。可以取消单条、全部停止，也可以继续添加视频。'
              : '视频一条一条转换。成功的会收起。没勾选抽帧和封面的只保存视频。'}
        </Text>
      </View>
      {cropOpen && sample ? (
        <CropEditor
          uri={sample.uri}
          initial={crop}
          onCancel={() => setCropOpen(false)}
          onConfirm={(next) => {
            setCrop(next);
            setCropSampleId(sample.id);
            setCropOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

function createMediaStyles(palette: Palette, accent: string) {
  return StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  titleActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 12,
  },
  title: {
    color: palette.text,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 8,
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  segment: {
    marginTop: 14,
    flexDirection: 'row',
    borderRadius: 12,
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    padding: 4,
  },
  previewSwitch: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  segmentItem: {
    flex: 1,
    minHeight: 36,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentOn: {
    backgroundColor: '#1F6FEB',
  },
  segmentText: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '700',
  },
  list: {
    flex: 1,
    marginTop: 8,
  },
  listContent: {
    paddingBottom: 12,
    gap: 10,
  },
  optionCard: {
    borderRadius: 12,
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  optionRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionLabel: {
    color: palette.text,
    fontSize: 15,
  },
  optionHint: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  zoomRow: {
    flexDirection: 'row',
    gap: 8,
  },
  zoomChip: {
    flex: 1,
    minHeight: 36,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.field,
  },
  zoomChipOn: {
    backgroundColor: '#1F6FEB',
  },
  zoomText: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '700',
  },
  itemScript: {
    minHeight: 64,
    marginTop: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: palette.text,
    backgroundColor: palette.field,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  extendBox: {
    gap: 8,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  timeInput: {
    width: 52,
    minHeight: 36,
    borderRadius: 8,
    paddingHorizontal: 8,
    color: palette.text,
    backgroundColor: palette.field,
    fontSize: 15,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  secondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.field,
  },
  secondaryText: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  listHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listTitle: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  link: {
    color: accent,
    fontSize: 14,
  },
  empty: {
    color: palette.muted,
    fontSize: 15,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardName: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  cardMeta: {
    color: palette.muted,
    fontSize: 13,
  },
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  preview: {
    width: '100%',
    height: 140,
    borderRadius: 10,
    backgroundColor: palette.field,
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: palette.field,
  },
  bar: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: accent,
  },
  cardStatus: {
    color: accent,
    fontSize: 13,
  },
  keepOriginal: {
    marginTop: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: accent,
  },
  keepOriginalText: {
    color: accent,
    fontSize: 14,
    fontWeight: '600',
  },
  ok: {
    color: '#3DDC97',
  },
  bad: {
    color: '#FF8B8B',
  },
  remove: {
    color: '#FF8B8B',
    fontSize: 14,
  },
  summary: {
    color: palette.text,
    fontSize: 14,
    marginBottom: 8,
  },
  footer: {
    paddingTop: 8,
    paddingBottom: 8,
  },
  primary: {
    minHeight: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F6FEB',
  },
  primaryDisabled: {
    opacity: 0.45,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  onAccentText: {
    color: '#FFFFFF',
  },
  footerHint: {
    marginTop: 8,
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});
}
