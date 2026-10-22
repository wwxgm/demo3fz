import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from '../modules/video-flip';
import { moveBox, scaleBox, type SmearBox } from './smearMath';
import { useTheme, type Palette } from './theme';
import { errorText } from './runtime';

type VideoPick = {
  uri: string;
  name: string;
  duration?: number;
};

type FaceImage = {
  uri: string;
  name: string;
};

type Box = { x: number; y: number; w: number; h: number };

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mpeg|mpg)$/i;
const DEFAULT_BOX: SmearBox = { x: 0.28, y: 0.12, width: 0.44, height: 0.32 };

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

export function FaceCoverScreen({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { color: accent, palette } = useTheme();
  const styles = useMemo(() => createFaceStyles(palette, accent), [palette, accent]);
  const [video, setVideo] = useState<VideoPick | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pixel, setPixel] = useState({ width: 0, height: 0 });
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [box, setBox] = useState<SmearBox>(DEFAULT_BOX);
  const [closedFace, setClosedFace] = useState<FaceImage | null>(null);
  const [openFace, setOpenFace] = useState<FaceImage | null>(null);
  const [talk, setTalk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const boxRef = useRef(box);
  const dragBox = useRef<SmearBox | null>(null);
  const fittedRef = useRef<Box>({ x: 0, y: 0, w: 1, h: 1 });
  const previewRef = useRef<string | null>(null);
  const frameToken = useRef(0);
  boxRef.current = box;
  previewRef.current = preview;

  const fitted = useMemo(
    () => contain(stage.width, stage.height, pixel.width || stage.width, pixel.height || stage.height),
    [stage, pixel],
  );
  fittedRef.current = fitted;

  useEffect(() => {
    return () => {
      if (previewRef.current) VideoFlip.removeTempFile(previewRef.current);
    };
  }, []);

  const drag = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragBox.current = boxRef.current;
      },
      onPanResponderMove: (_, gesture) => {
        const start = dragBox.current;
        const frame = fittedRef.current;
        if (!start || frame.w <= 0 || frame.h <= 0) return;
        setBox(moveBox(start, gesture.dx / frame.w, gesture.dy / frame.h));
      },
    }),
  ).current;

  const showFrame = async (uri: string) => {
    const token = frameToken.current + 1;
    frameToken.current = token;
    setLoadingFrame(true);
    try {
      const frame = await VideoFlip.frameAt(uri, 0.4);
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
    setVideo(next);
    setBox(DEFAULT_BOX);
    setPixel({ width: 0, height: 0 });
    void showFrame(next.uri);
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
      useVideo({
        uri: asset.uri,
        name: asset.fileName || baseName(asset.uri, '视频.mp4'),
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

  const pickFace = async (kind: 'closed' | 'open') => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      const face = { uri: asset.uri, name: asset.fileName || baseName(asset.uri, kind === 'closed' ? '闭嘴.png' : '张嘴.png') };
      if (kind === 'closed') setClosedFace(face);
      else setOpenFace(face);
    } catch (error) {
      Alert.alert('无法选择表情', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy) return;
    if (!video) {
      Alert.alert('还没有视频', '请先选择要盖住脸的视频。');
      return;
    }
    if (!closedFace) {
      Alert.alert('还没有表情', '请先选择闭嘴时的表情。');
      return;
    }
    if (Platform.OS !== 'ios') {
      Alert.alert('仅支持 iPhone', '表情遮脸目前只在 iPhone 安装包里可用。');
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
      output = await VideoFlip.coverFace(video.uri, {
        closedUri: closedFace.uri,
        openUri: openFace?.uri,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        talk: talk && Boolean(openFace),
      });
      await MediaLibrary.createAssetAsync(output);
      Alert.alert('已保存', '盖好表情的视频已保存到相册。');
    } catch (error) {
      Alert.alert('表情遮脸失败', errorText(error));
    } finally {
      if (output) VideoFlip.removeTempFile(output);
      setBusy(false);
    }
  };

  const spot = {
    left: fitted.x + box.x * fitted.w,
    top: fitted.y + box.y * fitted.h,
    width: box.width * fitted.w,
    height: box.height * fitted.h,
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 12) }]}>
      <View style={styles.titleRow}>
        <Pressable onPress={onClose} hitSlop={8} disabled={busy}>
          <Text style={styles.link}>返回</Text>
        </Pressable>
        <Text style={styles.title}>表情遮脸</Text>
        <View style={styles.titleSpacer} />
      </View>
      <Text style={styles.hint}>把表情拖到脸上盖住真人。再选一张张嘴图后，会跟着声音张开和闭上。人如果一直动，表情不会跟着走。</Text>
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
        {preview ? (
          <Image source={{ uri: preview }} style={styles.image} resizeMode="contain" />
        ) : (
          <Text style={styles.empty}>先选择视频</Text>
        )}
        {loadingFrame ? <ActivityIndicator color={accent} style={styles.spinner} /> : null}
        {preview && spot.width > 2 ? (
          <View {...drag.panHandlers} style={[styles.spot, { left: spot.left, top: spot.top, width: spot.width, height: spot.height }]}>
            {closedFace ? <Image source={{ uri: closedFace.uri }} style={styles.face} resizeMode="cover" /> : null}
          </View>
        ) : null}
      </View>
      <View style={styles.actions}>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFace('closed')}>
          <Text style={styles.secondaryText}>{closedFace ? '已选闭嘴' : '闭嘴表情'}</Text>
        </Pressable>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFace('open')}>
          <Text style={styles.secondaryText}>{openFace ? '已选张嘴' : '张嘴表情'}</Text>
        </Pressable>
      </View>
      <View style={styles.actions}>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => setBox((current) => scaleBox(current, 1 / 1.15))}>
          <Text style={styles.secondaryText}>缩小</Text>
        </Pressable>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => setBox((current) => scaleBox(current, 1.15))}>
          <Text style={styles.secondaryText}>放大</Text>
        </Pressable>
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.secondaryText}>跟着声音张嘴</Text>
        <Switch
          disabled={busy || !openFace}
          value={talk && Boolean(openFace)}
          onValueChange={setTalk}
          trackColor={{ false: palette.switchOff, true: accent }}
        />
      </View>
      <Pressable style={[styles.primary, busy && styles.primaryDisabled]} disabled={busy} onPress={() => void save()}>
        {busy ? <ActivityIndicator color="#F4F7FB" /> : <Text style={styles.primaryText}>盖上并保存</Text>}
      </Pressable>
    </View>
  );
}

function createFaceStyles(palette: Palette, accent: string) {
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
      overflow: 'hidden',
      backgroundColor: palette.bar,
    },
    image: { width: '100%', height: '100%' },
    empty: { marginTop: 24, textAlign: 'center', color: palette.muted, fontSize: 14 },
    spinner: { position: 'absolute', top: 12, alignSelf: 'center' },
    spot: {
      position: 'absolute',
      borderWidth: 1.5,
      borderColor: accent,
      overflow: 'hidden',
      backgroundColor: 'rgba(31,111,235,0.18)',
    },
    face: { width: '100%', height: '100%' },
    secondary: {
      flex: 1,
      minHeight: 38,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.field,
    },
    secondaryText: { color: palette.text, fontSize: 14, fontWeight: '600' },
    switchRow: {
      marginTop: 10,
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    primary: {
      marginTop: 10,
      minHeight: 48,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: accent,
    },
    primaryDisabled: { opacity: 0.7 },
    primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  });
}
