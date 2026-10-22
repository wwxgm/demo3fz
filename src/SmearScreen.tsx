import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from '../modules/video-flip';
import { applyGrip, type CropGrip } from './cropMath';
import { checkSmearTime, scaleBox, type SmearBox } from './smearMath';
import { useTheme, type Palette } from './theme';
import { errorText } from './runtime';

type Direction = 'horizontal' | 'vertical';

type Spot = {
  id: string;
  box: SmearBox;
  direction: Direction;
  start: string;
  end: string;
};

type VideoPick = {
  uri: string;
  name: string;
  duration?: number;
};

type Box = { x: number; y: number; w: number; h: number };

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mpeg|mpg)$/i;
const GRIPS: CropGrip[] = ['left', 'right', 'top', 'bottom', 'tl', 'tr', 'bl', 'br'];

function isVideo(name: string, mimeType?: string | null) {
  if (mimeType?.startsWith('video/')) return true;
  return VIDEO_EXT.test(name);
}

function baseName(uri: string, fallback: string) {
  const clean = uri.split('?')[0];
  try {
    return decodeURIComponent(clean.split('/').pop() || '') || fallback;
  } catch {
    return fallback;
  }
}

function contain(containerW: number, containerH: number, imageW: number, imageH: number): Box {
  if (containerW <= 0 || containerH <= 0 || imageW <= 0 || imageH <= 0) {
    return { x: 0, y: 0, w: Math.max(containerW, 0), h: Math.max(containerH, 0) };
  }
  const scale = Math.min(containerW / imageW, containerH / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: (containerW - w) / 2, y: (containerH - h) / 2, w, h };
}

function makeSpot(index: number, duration?: number): Spot {
  return {
    id: `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
    box: { x: 0.62, y: Math.min(0.04 + index * 0.14, 0.72), width: 0.28, height: 0.1 },
    direction: 'horizontal',
    start: '0',
    end: duration && duration > 0.2 ? String(Math.round(duration * 10) / 10) : '3',
  };
}

export function SmearScreen({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { color: accent, palette } = useTheme();
  const styles = useMemo(() => createSmearStyles(palette, accent), [palette, accent]);
  const [video, setVideo] = useState<VideoPick | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pixel, setPixel] = useState({ width: 0, height: 0 });
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [spots, setSpots] = useState<Spot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const spotsRef = useRef(spots);
  const selectedRef = useRef(selectedId);
  const dragBox = useRef<SmearBox | null>(null);
  const fittedRef = useRef<Box>({ x: 0, y: 0, w: 1, h: 1 });
  const previewRef = useRef<string | null>(null);
  const frameToken = useRef(0);
  spotsRef.current = spots;
  selectedRef.current = selectedId;
  previewRef.current = preview;

  const fitted = useMemo(
    () => contain(stage.width, stage.height, pixel.width || stage.width, pixel.height || stage.height),
    [stage, pixel],
  );
  fittedRef.current = fitted;
  const selected = spots.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    return () => {
      if (previewRef.current) VideoFlip.removeTempFile(previewRef.current);
    };
  }, []);

  const grips = useRef(
    GRIPS.reduce(
      (map, grip) => {
        map[grip] = PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            const id = selectedRef.current;
            dragBox.current = spotsRef.current.find((item) => item.id === id)?.box ?? null;
          },
          onPanResponderMove: (_, gesture) => {
            const id = selectedRef.current;
            const start = dragBox.current;
            const frame = fittedRef.current;
            if (!id || !start || frame.w <= 0 || frame.h <= 0) return;
            const next = applyGrip(start, grip, gesture.dx, gesture.dy, frame.w, frame.h);
            setSpots((prev) => prev.map((item) => (item.id === id ? { ...item, box: next } : item)));
          },
        });
        return map;
      },
      {} as Record<CropGrip, ReturnType<typeof PanResponder.create>>,
    ),
  ).current;

  const showFrame = async (uri: string, seconds: number) => {
    const token = frameToken.current + 1;
    frameToken.current = token;
    setLoadingFrame(true);
    try {
      const frame = await VideoFlip.frameAt(uri, seconds);
      if (token !== frameToken.current) {
        VideoFlip.removeTempFile(frame);
        return;
      }
      setPreview((current) => {
        if (current && current !== frame) VideoFlip.removeTempFile(current);
        return frame;
      });
      Image.getSize(
        frame,
        (width, height) => {
          if (token === frameToken.current) setPixel({ width, height });
        },
        () => {
          if (token === frameToken.current) setPixel({ width: 0, height: 0 });
        },
      );
    } catch (error) {
      if (token === frameToken.current) Alert.alert('无法读取画面', errorText(error));
    } finally {
      if (token === frameToken.current) setLoadingFrame(false);
    }
  };

  const useVideo = (next: VideoPick) => {
    const spot = makeSpot(0, next.duration);
    setVideo(next);
    setSpots([spot]);
    setSelectedId(spot.id);
    setPixel({ width: 0, height: 0 });
    void showFrame(next.uri, 0);
  };

  const pickLibrary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsMultipleSelection: false,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      const name = asset.fileName || baseName(asset.uri, '视频.mp4');
      useVideo({
        uri: asset.uri,
        name,
        duration: asset.duration && asset.duration > 0 ? asset.duration / 1000 : undefined,
      });
    } catch (error) {
      Alert.alert('无法打开相册', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['video/*', 'public.movie', 'public.mpeg-4'],
        multiple: false,
        copyToCacheDirectory: false,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (!isVideo(asset.name, asset.mimeType)) {
        Alert.alert('不是视频', '请选择一个视频。');
        return;
      }
      useVideo({ uri: asset.uri, name: asset.name });
    } catch (error) {
      Alert.alert('无法打开文件', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = (patch: Partial<Spot>) => {
    if (!selectedId) return;
    setSpots((prev) => prev.map((item) => (item.id === selectedId ? { ...item, ...patch } : item)));
  };

  const save = async () => {
    if (busy || !video) {
      if (!video) Alert.alert('还没有视频', '请先选择要涂抹的视频。');
      return;
    }
    if (spots.length === 0) {
      Alert.alert('还没有涂抹区域', '请先添加一处要盖住的位置。');
      return;
    }
    const regions = [];
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index];
      const time = checkSmearTime(Number(spot.start), Number(spot.end), video.duration);
      if (!time.ok) {
        Alert.alert(`第 ${index + 1} 处时间不对`, time.message);
        setSelectedId(spot.id);
        return;
      }
      regions.push({
        x: spot.box.x,
        y: spot.box.y,
        width: spot.box.width,
        height: spot.box.height,
        direction: spot.direction,
        start: time.start,
        end: time.end,
      });
    }
    if (Platform.OS !== 'ios') {
      Alert.alert('仅支持 iPhone', '涂抹并保存目前只在 iPhone 安装包里可用。');
      return;
    }
    const current = await MediaLibrary.getPermissionsAsync(true);
    const permission = current.granted ? current : await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) {
      Alert.alert('需要相册权限', '做好的视频要保存到手机相册，请允许添加照片。', [
        { text: '取消', style: 'cancel' },
        { text: '去设置', onPress: () => void Linking.openSettings() },
      ]);
      return;
    }
    setBusy(true);
    let output = '';
    try {
      output = await VideoFlip.coverSmear(video.uri, { regions });
      await MediaLibrary.createAssetAsync(output);
      Alert.alert('已保存', '涂抹后的视频已保存到相册。');
    } catch (error) {
      Alert.alert('涂抹失败', errorText(error));
    } finally {
      if (output) VideoFlip.removeTempFile(output);
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 12) }]}>
      <View style={styles.titleRow}>
        <Pressable onPress={onClose} hitSlop={8} disabled={busy}>
          <Text style={styles.link}>返回</Text>
        </Pressable>
        <Text style={styles.title}>去除水印</Text>
        <View style={styles.titleSpacer} />
      </View>
      <Text style={styles.hint}>
        框住要盖住的位置，可同时加多处。横向用左右旁边的画面涂过去，纵向用上下旁边的画面涂过去。每处可以单独设置时间。拖边只动这一条边。
      </Text>
      <View style={styles.actions}>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickLibrary()}>
          <Text style={styles.secondaryText}>相册视频</Text>
        </Pressable>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFile()}>
          <Text style={styles.secondaryText}>文件视频</Text>
        </Pressable>
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {video ? video.name : '还没有选择视频'}
        {video?.duration ? ` · ${Math.round(video.duration)} 秒` : ''}
      </Text>
      <View
        style={styles.stage}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setStage({ width, height });
        }}
      >
        {preview ? <Image source={{ uri: preview }} style={styles.image} resizeMode="contain" /> : null}
        {loadingFrame ? <ActivityIndicator color={accent} style={styles.spinner} /> : null}
        {fitted.w > 0
          ? [...spots.filter((item) => item.id !== selectedId), ...spots.filter((item) => item.id === selectedId)].map((spot) => {
              const on = spot.id === selectedId;
              const place = {
                left: fitted.x + spot.box.x * fitted.w,
                top: fitted.y + spot.box.y * fitted.h,
                width: spot.box.width * fitted.w,
                height: spot.box.height * fitted.h,
              };
              return (
                <View
                  key={spot.id}
                  style={[styles.spot, place, on && styles.spotOn]}
                  pointerEvents="box-none"
                >
                  {!on ? (
                    <Pressable style={styles.fill} onPress={() => setSelectedId(spot.id)} />
                  ) : (
                    <>
                      <View style={styles.edgeLeft} {...grips.left.panHandlers}>
                        <View style={styles.barV} />
                      </View>
                      <View style={styles.edgeRight} {...grips.right.panHandlers}>
                        <View style={styles.barV} />
                      </View>
                      <View style={styles.edgeTop} {...grips.top.panHandlers}>
                        <View style={styles.barH} />
                      </View>
                      <View style={styles.edgeBottom} {...grips.bottom.panHandlers}>
                        <View style={styles.barH} />
                      </View>
                      <View style={[styles.corner, styles.cornerTL]} {...grips.tl.panHandlers} />
                      <View style={[styles.corner, styles.cornerTR]} {...grips.tr.panHandlers} />
                      <View style={[styles.corner, styles.cornerBL]} {...grips.bl.panHandlers} />
                      <View style={[styles.corner, styles.cornerBR]} {...grips.br.panHandlers} />
                    </>
                  )}
                </View>
              );
            })
          : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {spots.map((spot, index) => (
          <Pressable
            key={spot.id}
            style={[styles.chip, spot.id === selectedId && styles.chipOn]}
            onPress={() => setSelectedId(spot.id)}
          >
            <Text style={[styles.chipText, spot.id === selectedId && styles.chipTextOn]}>第 {index + 1} 处</Text>
          </Pressable>
        ))}
        <Pressable
          style={styles.chip}
          disabled={busy || spots.length >= 8}
          onPress={() => {
            const spot = makeSpot(spots.length, video?.duration);
            setSpots((prev) => [...prev, spot].slice(0, 8));
            setSelectedId(spot.id);
          }}
        >
          <Text style={styles.chipText}>添加一处</Text>
        </Pressable>
      </ScrollView>
      {selected ? (
        <View style={styles.panel}>
          <View style={styles.row}>
            <Pressable
              style={[styles.secondary, selected.direction === 'horizontal' && styles.choiceOn]}
              onPress={() => updateSelected({ direction: 'horizontal' })}
            >
              <Text style={styles.secondaryText}>横向涂抹</Text>
            </Pressable>
            <Pressable
              style={[styles.secondary, selected.direction === 'vertical' && styles.choiceOn]}
              onPress={() => updateSelected({ direction: 'vertical' })}
            >
              <Text style={styles.secondaryText}>纵向涂抹</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Pressable style={styles.secondary} onPress={() => updateSelected({ box: scaleBox(selected.box, 1 / 1.15) })}>
              <Text style={styles.secondaryText}>缩小</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={() => updateSelected({ box: scaleBox(selected.box, 1.15) })}>
              <Text style={styles.secondaryText}>放大</Text>
            </Pressable>
            <Pressable
              style={styles.secondary}
              disabled={!video || loadingFrame}
              onPress={() => video && void showFrame(video.uri, Number(selected.start) || 0)}
            >
              <Text style={styles.secondaryText}>看这一帧</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>开始</Text>
            <TextInput
              value={selected.start}
              onChangeText={(start) => updateSelected({ start })}
              keyboardType="decimal-pad"
              style={styles.input}
            />
            <Text style={styles.label}>结束</Text>
            <TextInput
              value={selected.end}
              onChangeText={(end) => updateSelected({ end })}
              keyboardType="decimal-pad"
              style={styles.input}
            />
            <Pressable
              onPress={() => {
                setSpots((prev) => prev.filter((item) => item.id !== selected.id));
                setSelectedId((current) => (current === selected.id ? null : current));
              }}
              hitSlop={8}
            >
              <Text style={styles.remove}>删除</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Text style={styles.hint}>先选择视频，再点「添加一处」框住水印。</Text>
      )}
      <Pressable style={[styles.primary, busy && styles.primaryDisabled]} disabled={busy} onPress={() => void save()}>
        {busy ? <ActivityIndicator color="#F4F7FB" /> : <Text style={styles.primaryText}>涂抹并保存</Text>}
      </Pressable>
    </View>
  );
}

function createSmearStyles(palette: Palette, accent: string) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.background, paddingHorizontal: 16 },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { color: palette.text, fontSize: 22, fontWeight: '700' },
    titleSpacer: { width: 40 },
    link: { color: accent, fontSize: 16, fontWeight: '600' },
    hint: { marginTop: 8, color: palette.muted, fontSize: 13, lineHeight: 18 },
    meta: { marginTop: 8, color: palette.muted, fontSize: 13 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
    stage: {
      flex: 1,
      marginTop: 10,
      borderRadius: 12,
      overflow: 'visible',
      backgroundColor: palette.bar,
    },
    image: { width: '100%', height: '100%' },
    spinner: { position: 'absolute', top: 12, alignSelf: 'center' },
    spot: { position: 'absolute', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)', backgroundColor: 'rgba(255,255,255,0.12)' },
    spotOn: { borderColor: accent, backgroundColor: 'rgba(31,111,235,0.18)' },
    fill: { flex: 1 },
    edgeLeft: { position: 'absolute', left: -16, top: 10, bottom: 10, width: 32, alignItems: 'center', justifyContent: 'center' },
    edgeRight: { position: 'absolute', right: -16, top: 10, bottom: 10, width: 32, alignItems: 'center', justifyContent: 'center' },
    edgeTop: { position: 'absolute', top: -16, left: 10, right: 10, height: 32, alignItems: 'center', justifyContent: 'center' },
    edgeBottom: { position: 'absolute', bottom: -16, left: 10, right: 10, height: 32, alignItems: 'center', justifyContent: 'center' },
    barV: { width: 4, height: 22, borderRadius: 2, backgroundColor: '#FFFFFF' },
    barH: { width: 22, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF' },
    corner: { position: 'absolute', width: 16, height: 16, borderColor: '#FFFFFF' },
    cornerTL: { left: -2, top: -2, borderLeftWidth: 3, borderTopWidth: 3 },
    cornerTR: { right: -2, top: -2, borderRightWidth: 3, borderTopWidth: 3 },
    cornerBL: { left: -2, bottom: -2, borderLeftWidth: 3, borderBottomWidth: 3 },
    cornerBR: { right: -2, bottom: -2, borderRightWidth: 3, borderBottomWidth: 3 },
    chips: { gap: 8, paddingVertical: 10 },
    chip: { minHeight: 34, paddingHorizontal: 12, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.field },
    chipOn: { backgroundColor: accent },
    chipText: { color: palette.text, fontSize: 13, fontWeight: '600' },
    chipTextOn: { color: '#FFFFFF' },
    panel: { gap: 8 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    secondary: { flex: 1, minHeight: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.field },
    choiceOn: { borderWidth: 1.5, borderColor: accent },
    secondaryText: { color: palette.text, fontSize: 14, fontWeight: '600' },
    label: { color: palette.muted, fontSize: 13 },
    input: { width: 64, minHeight: 38, borderRadius: 10, paddingHorizontal: 8, color: palette.text, backgroundColor: palette.field },
    remove: { color: '#FE2C55', fontSize: 14, fontWeight: '600' },
    primary: { marginTop: 10, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: accent },
    primaryDisabled: { opacity: 0.7 },
    primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  });
}
