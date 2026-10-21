import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { WatermarkForm } from './WatermarkForm';
import { useTheme } from './theme';
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

function formatDuration(durationMs?: number) {
  if (!durationMs || durationMs <= 0) return '';
  const total = Math.round(durationMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function MediaScreen() {
  const insets = useSafeAreaInsets();
  const { color: accent } = useTheme();
  const [kind, setKind] = useState<Kind>('video');
  const [videos, setVideos] = useState<MediaItem[]>([]);
  const [images, setImages] = useState<MediaItem[]>([]);
  const [watermark, setWatermark] = useState<WatermarkSettings>(defaultWatermark);
  const [zoom, setZoom] = useState(1);
  const [subtitleScript, setSubtitleScript] = useState('');
  const [sampleFrames, setSampleFrames] = useState(false);
  const [useCurrentClip, setUseCurrentClip] = useState(true);
  const [extendVideo, setExtendVideo] = useState(false);
  const [clipStart, setClipStart] = useState('3');
  const [clipEnd, setClipEnd] = useState('6');
  const [freezeSeconds, setFreezeSeconds] = useState('6');
  const [highlightMode, setHighlightMode] = useState<'normal' | 'slow' | 'slowZoom'>('normal');
  const [filterOn, setFilterOn] = useState(false);
  const [filterName, setFilterName] = useState<'vivid' | 'warm' | 'cool' | 'mono'>('vivid');
  const [followOn, setFollowOn] = useState(false);
  const [followClip, setFollowClip] = useState<{ uri: string; name: string } | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [flipImages, setFlipImages] = useState(false);
  const [crop, setCrop] = useState<CropNorm | null>(null);
  const [cropSampleId, setCropSampleId] = useState<string | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [summary, setSummary] = useState('');
  const busy = running || picking;
  const items = kind === 'video' ? videos : images;
  const setItems = kind === 'video' ? setVideos : setImages;
  const sample = images.find((item) => item.id === cropSampleId) ?? images[0];

  const addItems = (next: MediaItem[], target: Kind) => {
    if (next.length === 0) {
      Alert.alert(target === 'video' ? '没有视频' : '没有图片', '请重新选择。');
      return;
    }
    setSummary('');
    const update = target === 'video' ? setVideos : setImages;
    update((prev) => {
      const seen = new Set(prev.map((item) => item.uri));
      return [...prev, ...next.filter((item) => !seen.has(item.uri))];
    });
    if (target === 'image') {
      setCropSampleId((current) => current ?? next[0]?.id ?? null);
    }
  };

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
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: kind === 'video' ? ['video/*', 'public.movie', 'public.mpeg-4'] : ['image/*', 'public.image'],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
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
    } catch (error) {
      Alert.alert('无法打开文件', errorText(error));
    } finally {
      setPicking(false);
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
    if (!watermark.enabled) return true;
    if (!watermark.placeLeft && !watermark.placeCenter) {
      Alert.alert('请选择水印位置', '左边或中央至少打开一个。');
      return false;
    }
    return true;
  };

  const run = async () => {
    if (busy) return;
    const queue = items.filter((item) => item.status !== 'saved');
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
    }
    if (kind === 'video' && followOn && !followClip) {
      Alert.alert('还没有关注片段', '请先上传末尾要接上的视频，或关掉这个开关。');
      return;
    }
    if (kind === 'image' && !flipImages && !watermark.enabled && !crop) {
      Alert.alert('还没有处理项', '请勾选水平翻转、水印，或先设置裁剪。');
      return;
    }
    const allowed = await ensurePermission();
    if (!allowed) return;

    const heavy =
      kind === 'video' &&
      (watermark.enabled ||
        filterOn ||
        extendVideo ||
        followOn ||
        sampleFrames ||
        zoom > 1 ||
        subtitleScript.trim().length > 0);

    setRunning(true);
    setSummary('');
    let saved = 0;
    let failed = 0;
    const saveNext = createSaveQueue();
    const mark = watermarkPayload(watermark);
    const subtitleLines = subtitleScript.split(/\r?\n/);

    await runWithLimit(queue, heavy ? 1 : 2, async (item) => {
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'processing', message: '正在处理…' } : it)),
      );
      let outputUri = '';
      let frameUris: string[] = [];
      try {
        outputUri =
          kind === 'video'
            ? await VideoFlip.flipHorizontal(item.uri, {
                watermark: mark,
                zoom,
                subtitle: subtitleLines[items.findIndex((it) => it.id === item.id)]?.trim() || undefined,
                extend:
                  extendVideo && useCurrentClip
                    ? {
                        start: Number(clipStart),
                        end: Number(clipEnd),
                        freeze: Number(freezeSeconds),
                        mode: highlightMode,
                      }
                    : undefined,
                filter: filterOn ? filterName : undefined,
              })
            : await VideoFlip.processImage(item.uri, {
                flip: flipImages,
                crop: crop ?? undefined,
                watermark: mark,
              });
        if (kind === 'video' && followOn && followClip) {
          const joined = await VideoFlip.joinVideos([outputUri, followClip.uri]);
          VideoFlip.removeTempFile(outputUri);
          outputUri = joined;
        }
        if (kind === 'video' && sampleFrames) {
          try {
            frameUris = await VideoFlip.sampleFrames(outputUri, 4);
          } catch {
            frameUris = [];
          }
        }
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'saving', message: '等待写入相册…' } : it)),
        );
        await saveNext(async () => {
          setItems((prev) =>
            prev.map((it) => (it.id === item.id ? { ...it, status: 'saving', message: '正在保存到相册…' } : it)),
          );
          for (const frame of frameUris) {
            try {
              await MediaLibrary.createAssetAsync(frame);
            } catch {
              // 抽帧失败不影响视频本身保存。
            }
            VideoFlip.removeTempFile(frame);
          }
          await MediaLibrary.createAssetAsync(outputUri);
        });
        saved += 1;
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: 'saved',
                  message: frameUris.length > 0 ? `已保存到相册，并抽出 ${frameUris.length} 张` : '已保存到相册',
                }
              : it,
          ),
        );
      } catch (error) {
        failed += 1;
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'failed', message: errorText(error) } : it)),
        );
      } finally {
        for (const frame of frameUris) VideoFlip.removeTempFile(frame);
        if (outputUri) VideoFlip.removeTempFile(outputUri);
      }
    });

    const text =
      failed === 0
        ? `已把 ${saved} 个保存到相册`
        : `成功 ${saved} 个，失败 ${failed} 个。失败的可以再点一次重试`;
    setSummary(text);
    setRunning(false);
    Alert.alert(failed === 0 ? '已保存' : '处理结束', text);
  };

  const pendingCount = items.filter((item) => item.status !== 'saved').length;

  const refreshVideo = () => {
    if (busy) return;
    setKind('video');
    setVideos([]);
    setWatermark(defaultWatermark);
    setZoom(1);
    setSubtitleScript('');
    setSampleFrames(false);
    setUseCurrentClip(true);
    setExtendVideo(false);
    setClipStart('3');
    setClipEnd('6');
    setFreezeSeconds('6');
    setHighlightMode('normal');
    setFilterOn(false);
    setFilterName('vivid');
    setFollowOn(false);
    setFollowClip(null);
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
          copyToCacheDirectory: true,
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

  if (mergeOpen) {
    return <MergeScreen onClose={() => setMergeOpen(false)} />;
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{kind === 'video' ? '视频处理' : '图片处理'}</Text>
        {kind === 'video' ? (
          <View style={styles.titleActions}>
            <Pressable disabled={busy} onPress={refreshVideo} hitSlop={8}>
              <Text style={styles.link}>刷新</Text>
            </Pressable>
            <Pressable disabled={busy} onPress={() => setMergeOpen(true)} hitSlop={8}>
              <Text style={styles.link}>合并</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <Text style={styles.subtitle}>
        {kind === 'video'
          ? '可多选视频，一键左右镜像。放大和字幕按批处理，水印默认关闭。'
          : '可多选图片。翻转、水印和裁剪会一起应用到全部，并保存到相册。'}
      </Text>
      <View style={styles.segment}>
        <Pressable style={[styles.segmentItem, kind === 'video' && styles.segmentOn]} onPress={() => setKind('video')}>
          <Text style={styles.segmentText}>视频</Text>
        </Pressable>
        <Pressable style={[styles.segmentItem, kind === 'image' && styles.segmentOn]} onPress={() => setKind('image')}>
          <Text style={styles.segmentText}>图片</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {kind === 'video' ? (
          <View style={styles.optionCard}>
            <Text style={styles.optionLabel}>放大倍数</Text>
            <View style={styles.zoomRow}>
              {[1, 1.1, 1.2].map((value) => (
                <Pressable
                  key={value}
                  style={[styles.zoomChip, zoom === value && styles.zoomChipOn, zoom === value && { backgroundColor: accent }]}
                  onPress={() => setZoom(value)}
                >
                  <Text style={styles.zoomText}>{value === 1 ? '不放大' : `${value}`}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.optionLabel}>解说字幕</Text>
            <TextInput
              value={subtitleScript}
              onChangeText={setSubtitleScript}
              placeholder={'一行对应一个视频\n第二行给第二个视频'}
              placeholderTextColor="#6E8498"
              multiline
              style={styles.script}
            />
            <Text style={styles.optionHint}>
              空行表示该视频不加字幕。有字的视频会用系统中文男声解说，字幕和声音一起出现，原声在解说期间变小。
            </Text>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>随机抽帧</Text>
              <Switch
                value={sampleFrames}
                onValueChange={setSampleFrames}
                trackColor={{ false: 'rgba(255,255,255,0.15)', true: accent }}
              />
            </View>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>延长视频</Text>
              <Switch
                value={extendVideo}
                onValueChange={setExtendVideo}
                trackColor={{ false: 'rgba(255,255,255,0.15)', true: accent }}
              />
            </View>
            {extendVideo ? (
              <View style={styles.extendBox}>
                <View style={styles.optionRow}>
                  <Text style={styles.optionLabel}>当前视频</Text>
                  <Switch
                    value={useCurrentClip}
                    onValueChange={setUseCurrentClip}
                    trackColor={{ false: 'rgba(255,255,255,0.15)', true: accent }}
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
                      <Text style={styles.zoomText}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.optionHint}>
                  先播到片段结束，定格后再插入这一段。慢速只拉长画面。视频短于结束时间时，这一条会失败。
                </Text>
              </View>
            ) : null}
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>批量滤镜</Text>
              <Switch
                value={filterOn}
                onValueChange={setFilterOn}
                trackColor={{ false: 'rgba(255,255,255,0.15)', true: accent }}
              />
            </View>
            {filterOn ? (
              <View style={styles.zoomRow}>
                {(
                  [
                    ['vivid', '鲜艳'],
                    ['warm', '暖色'],
                    ['cool', '冷色'],
                    ['mono', '黑白'],
                  ] as const
                ).map(([name, label]) => (
                  <Pressable
                    key={name}
                    style={[styles.zoomChip, filterName === name && styles.zoomChipOn, filterName === name && { backgroundColor: accent }]}
                    onPress={() => setFilterName(name)}
                  >
                    <Text style={styles.zoomText}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Text style={styles.optionHint}>这些开关默认关闭。不勾选时，仍只做原来的翻转、放大和解说。</Text>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>末尾关注</Text>
              <Switch
                value={followOn}
                onValueChange={setFollowOn}
                trackColor={{ false: 'rgba(255,255,255,0.15)', true: accent }}
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
        <WatermarkForm value={watermark} onChange={setWatermark} />
        {kind === 'image' ? (
          <View style={styles.optionCard}>
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>水平翻转</Text>
              <Switch
                value={flipImages}
                onValueChange={setFlipImages}
                trackColor={{ false: 'rgba(255,255,255,0.15)', true: accent }}
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
          {items.length > 0 && !busy ? (
            <Pressable
              onPress={() => {
                setItems([]);
                if (kind === 'image') setCropSampleId(null);
              }}
            >
              <Text style={styles.link}>清空</Text>
            </Pressable>
          ) : null}
        </View>
        {items.length === 0 ? (
          <Text style={styles.empty}>还没有文件。可以一次多选。</Text>
        ) : (
          items.map((item, index) => {
            const meta = [item.source, formatDuration(item.durationMs), formatSize(item.size)].filter(Boolean).join(' · ');
            const isSample = kind === 'image' && sample?.id === item.id;
            return (
              <View key={item.id} style={styles.card}>
                <View style={styles.cardBody}>
                  <Text style={styles.cardName} numberOfLines={2}>
                    {index + 1}. {item.name}
                    {isSample ? ' · 样板' : ''}
                  </Text>
                  {meta ? <Text style={styles.cardMeta}>{meta}</Text> : null}
                  {item.message ? (
                    <Text
                      style={[
                        styles.cardStatus,
                        item.status === 'saved' && styles.ok,
                        item.status === 'failed' && styles.bad,
                      ]}
                    >
                      {item.message}
                    </Text>
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
                {!busy ? (
                  <Pressable
                    onPress={() => {
                      setItems((prev) => prev.filter((it) => it.id !== item.id));
                      if (cropSampleId === item.id) setCropSampleId(null);
                    }}
                    hitSlop={10}
                  >
                    <Text style={styles.remove}>移除</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
      {summary ? <Text style={styles.summary}>{summary}</Text> : null}
      <View style={styles.footer}>
        <Pressable
          style={[styles.primary, { backgroundColor: accent }, (busy || pendingCount === 0) && styles.primaryDisabled]}
          disabled={busy || pendingCount === 0}
          onPress={() => void run()}
        >
          {busy ? (
            <ActivityIndicator color="#F4F7FB" />
          ) : (
            <Text style={styles.primaryText}>
              {kind === 'video' ? `一键水平翻转并保存（${pendingCount}）` : `处理并保存（${pendingCount}）`}
            </Text>
          )}
        </Pressable>
        <Text style={styles.footerHint}>
          {picking ? '正在读取…' : '最多同时处理 2 个，保存到相册会排队。请留在这个页面。'}
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

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  titleActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  title: {
    color: '#F4F7FB',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 8,
    color: '#9BB0C5',
    fontSize: 14,
    lineHeight: 20,
  },
  segment: {
    marginTop: 14,
    flexDirection: 'row',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    padding: 4,
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
    color: '#F4F7FB',
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
    backgroundColor: 'rgba(255,255,255,0.06)',
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
    color: '#F4F7FB',
    fontSize: 15,
  },
  optionHint: {
    color: '#9BB0C5',
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
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  zoomChipOn: {
    backgroundColor: '#1F6FEB',
  },
  zoomText: {
    color: '#F4F7FB',
    fontSize: 14,
    fontWeight: '700',
  },
  script: {
    minHeight: 88,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#F4F7FB',
    backgroundColor: 'rgba(255,255,255,0.08)',
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
    color: '#F4F7FB',
    backgroundColor: 'rgba(255,255,255,0.08)',
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
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  secondaryText: {
    color: '#F4F7FB',
    fontSize: 15,
    fontWeight: '600',
  },
  listHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listTitle: {
    color: '#F4F7FB',
    fontSize: 15,
    fontWeight: '600',
  },
  link: {
    color: '#8EB6FF',
    fontSize: 14,
  },
  empty: {
    color: '#9BB0C5',
    fontSize: 15,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardName: {
    color: '#F4F7FB',
    fontSize: 15,
    fontWeight: '600',
  },
  cardMeta: {
    color: '#9BB0C5',
    fontSize: 13,
  },
  cardStatus: {
    color: '#8EB6FF',
    fontSize: 13,
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
    color: '#F4F7FB',
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
    color: '#F4F7FB',
    fontSize: 17,
    fontWeight: '700',
  },
  footerHint: {
    marginTop: 8,
    color: '#9BB0C5',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});
