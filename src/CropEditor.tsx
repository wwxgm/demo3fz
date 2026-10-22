import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CropNorm } from './runtime';
import { useTheme, type Palette } from './theme';

type Props = {
  uri: string;
  initial?: CropNorm | null;
  onCancel: () => void;
  onConfirm: (crop: CropNorm) => void;
};

type Box = { x: number; y: number; w: number; h: number };

const MIN_NORM = 0.08;

function contain(containerW: number, containerH: number, imageW: number, imageH: number): Box {
  if (containerW <= 0 || containerH <= 0 || imageW <= 0 || imageH <= 0) {
    return { x: 0, y: 0, w: containerW, h: containerH };
  }
  const scale = Math.min(containerW / imageW, containerH / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: (containerW - w) / 2, y: (containerH - h) / 2, w, h };
}

function clampCrop(crop: CropNorm): CropNorm {
  const width = Math.min(Math.max(crop.width, MIN_NORM), 1);
  const height = Math.min(Math.max(crop.height, MIN_NORM), 1);
  const x = Math.min(Math.max(crop.x, 0), 1 - width);
  const y = Math.min(Math.max(crop.y, 0), 1 - height);
  return { x, y, width, height };
}

export function CropEditor({ uri, initial, onCancel, onConfirm }: Props) {
  const insets = useSafeAreaInsets();
  const { color: accent, palette } = useTheme();
  const styles = useMemo(() => createCropStyles(palette, accent), [palette, accent]);
  const [pixel, setPixel] = useState({ width: 0, height: 0 });
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [crop, setCrop] = useState<CropNorm>(initial ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  const [widthText, setWidthText] = useState('');
  const [heightText, setHeightText] = useState('');
  const cropRef = useRef(crop);
  const dragStart = useRef(crop);
  const fittedRef = useRef<Box>({ x: 0, y: 0, w: 1, h: 1 });
  cropRef.current = crop;

  useEffect(() => {
    let alive = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (alive) setPixel({ width, height });
      },
      () => {
        if (alive) setPixel({ width: 0, height: 0 });
      },
    );
    return () => {
      alive = false;
    };
  }, [uri]);

  useEffect(() => {
    if (pixel.width > 0) setWidthText(String(Math.round(crop.width * pixel.width)));
    if (pixel.height > 0) setHeightText(String(Math.round(crop.height * pixel.height)));
  }, [crop.width, crop.height, pixel.width, pixel.height]);

  const fitted = useMemo(
    () => contain(stage.width, stage.height, pixel.width || 1, pixel.height || 1),
    [stage, pixel],
  );
  fittedRef.current = fitted;

  const moveResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        dragStart.current = { ...cropRef.current };
      },
      onPanResponderMove: (_, gesture) => {
        const frame = fittedRef.current;
        const start = dragStart.current;
        if (frame.w <= 0 || frame.h <= 0) return;
        setCrop(
          clampCrop({
            ...start,
            x: start.x + gesture.dx / frame.w,
            y: start.y + gesture.dy / frame.h,
          }),
        );
      },
    }),
  ).current;

  const resizeStart = useRef(crop);
  const resizeResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        resizeStart.current = { ...cropRef.current };
      },
      onPanResponderMove: (_, gesture) => {
        const frame = fittedRef.current;
        const start = resizeStart.current;
        if (frame.w <= 0 || frame.h <= 0) return;
        setCrop(
          clampCrop({
            ...start,
            width: start.width + gesture.dx / frame.w,
            height: start.height + gesture.dy / frame.h,
          }),
        );
      },
    }),
  ).current;

  const cropStyle = {
    left: fitted.x + crop.x * fitted.w,
    top: fitted.y + crop.y * fitted.h,
    width: crop.width * fitted.w,
    height: crop.height * fitted.h,
  };

  const commitWidth = () => {
    const next = Number(widthText);
    if (!pixel.width || !Number.isFinite(next)) return;
    setCrop(clampCrop({ ...cropRef.current, width: next / pixel.width }));
  };

  const commitHeight = () => {
    const next = Number(heightText);
    if (!pixel.height || !Number.isFinite(next)) return;
    setCrop(clampCrop({ ...cropRef.current, height: next / pixel.height }));
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={[styles.screen, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 12) }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Text style={styles.title}>自定义裁剪</Text>
        <Text style={styles.hint}>拖动选区，右下角可改大小。批量时按这张图的比例应用到其他已选图片。</Text>
        <View
          style={styles.stage}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setStage({ width, height });
          }}
        >
          <Image source={{ uri }} style={styles.image} resizeMode="contain" />
          {fitted.w > 0 ? (
            <View style={[styles.crop, cropStyle]} {...moveResponder.panHandlers}>
              <View style={styles.gridV1} />
              <View style={styles.gridV2} />
              <View style={styles.gridH1} />
              <View style={styles.gridH2} />
              <View style={styles.handle} {...resizeResponder.panHandlers} />
            </View>
          ) : null}
        </View>
        <View style={styles.sizes}>
          <Text style={styles.sizeLabel}>
            {pixel.width > 0 ? `原图 ${pixel.width} × ${pixel.height}` : '正在读取尺寸…'}
          </Text>
          <View style={styles.sizeRow}>
            <Text style={styles.sizeLabel}>宽度</Text>
            <TextInput
              value={widthText}
              onChangeText={setWidthText}
              onEndEditing={commitWidth}
              keyboardType="number-pad"
              style={styles.sizeInput}
            />
            <Text style={styles.sizeLabel}>高度</Text>
            <TextInput
              value={heightText}
              onChangeText={setHeightText}
              onEndEditing={commitHeight}
              keyboardType="number-pad"
              style={styles.sizeInput}
            />
          </View>
        </View>
        <View style={styles.actions}>
          <Pressable style={styles.secondary} onPress={onCancel}>
            <Text style={styles.secondaryText}>取消</Text>
          </Pressable>
          <Pressable style={[styles.primary, { backgroundColor: accent }]} onPress={() => onConfirm(clampCrop(cropRef.current))}>
            <Text style={styles.primaryText}>使用这个裁剪</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createCropStyles(palette: Palette, accent: string) {
  return StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
    paddingHorizontal: 16,
  },
  title: {
    color: palette.text,
    fontSize: 22,
    fontWeight: '700',
  },
  hint: {
    marginTop: 8,
    color: palette.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  stage: {
    flex: 1,
    marginTop: 12,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: palette.bar,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  crop: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: '#F4F7FB',
  },
  gridV1: {
    position: 'absolute',
    left: '33.33%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  gridV2: {
    position: 'absolute',
    left: '66.66%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  gridH1: {
    position: 'absolute',
    top: '33.33%',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  gridH2: {
    position: 'absolute',
    top: '66.66%',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  handle: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: accent,
    borderWidth: 2,
    borderColor: '#F4F7FB',
  },
  sizes: {
    marginTop: 12,
    gap: 8,
  },
  sizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sizeLabel: {
    color: palette.muted,
    fontSize: 13,
  },
  sizeInput: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    paddingHorizontal: 10,
    color: palette.text,
    backgroundColor: palette.field,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
  },
  secondary: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.field,
  },
  secondaryText: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '600',
  },
  primary: {
    flex: 1.4,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F6FEB',
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
}
