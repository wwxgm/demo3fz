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
import { applyGrip, CropGrip, normalizeCrop, setCropHeight, setCropWidth } from './cropMath';
import { useTheme, type Palette } from './theme';

type Props = {
  uri: string;
  initial?: CropNorm | null;
  onCancel: () => void;
  onConfirm: (crop: CropNorm) => void;
};

type Box = { x: number; y: number; w: number; h: number };

function contain(containerW: number, containerH: number, imageW: number, imageH: number): Box {
  if (containerW <= 0 || containerH <= 0 || imageW <= 0 || imageH <= 0) {
    return { x: 0, y: 0, w: containerW, h: containerH };
  }
  const scale = Math.min(containerW / imageW, containerH / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: (containerW - w) / 2, y: (containerH - h) / 2, w, h };
}

export function CropEditor({ uri, initial, onCancel, onConfirm }: Props) {
  const insets = useSafeAreaInsets();
  const { color: accent, palette } = useTheme();
  const styles = useMemo(() => createCropStyles(palette), [palette]);
  const [pixel, setPixel] = useState({ width: 0, height: 0 });
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [crop, setCrop] = useState<CropNorm>(normalizeCrop(initial ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }));
  const [widthText, setWidthText] = useState('');
  const [heightText, setHeightText] = useState('');
  const cropRef = useRef(crop);
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

  const gripStart = useRef(crop);
  const grips = useRef(
    (['left', 'right', 'top', 'bottom', 'tl', 'tr', 'bl', 'br'] as CropGrip[]).reduce(
      (map, grip) => {
        map[grip] = PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            gripStart.current = { ...cropRef.current };
          },
          onPanResponderMove: (_, gesture) => {
            const frame = fittedRef.current;
            setCrop(applyGrip(gripStart.current, grip, gesture.dx, gesture.dy, frame.w, frame.h));
          },
        });
        return map;
      },
      {} as Record<CropGrip, ReturnType<typeof PanResponder.create>>,
    ),
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
    setCrop(setCropWidth(cropRef.current, next / pixel.width));
  };

  const commitHeight = () => {
    const next = Number(heightText);
    if (!pixel.height || !Number.isFinite(next)) return;
    setCrop(setCropHeight(cropRef.current, next / pixel.height));
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={[styles.screen, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 12) }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Text style={styles.title}>自定义裁剪</Text>
        <Text style={styles.hint}>拖上、下、左、右，只移动这一条边。拖角落时，对角保持不动。</Text>
        <View
          style={styles.stage}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setStage({ width, height });
          }}
        >
          <Image source={{ uri }} style={styles.image} resizeMode="contain" />
          {fitted.w > 0 ? (
            <>
              <View pointerEvents="none" style={[styles.shade, { top: 0, left: 0, right: 0, height: Math.max(cropStyle.top, 0) }]} />
              <View
                pointerEvents="none"
                style={[styles.shade, { top: cropStyle.top + cropStyle.height, left: 0, right: 0, bottom: 0 }]}
              />
              <View
                pointerEvents="none"
                style={[styles.shade, { top: cropStyle.top, left: 0, width: Math.max(cropStyle.left, 0), height: cropStyle.height }]}
              />
              <View
                pointerEvents="none"
                style={[styles.shade, { top: cropStyle.top, left: cropStyle.left + cropStyle.width, right: 0, height: cropStyle.height }]}
              />
              <View style={[styles.crop, cropStyle]} pointerEvents="box-none">
                <View pointerEvents="none" style={styles.gridV1} />
                <View pointerEvents="none" style={styles.gridV2} />
                <View pointerEvents="none" style={styles.gridH1} />
                <View pointerEvents="none" style={styles.gridH2} />
                <View style={styles.edgeLeft} {...grips.left.panHandlers}>
                  <View style={styles.edgeBarV} />
                </View>
                <View style={styles.edgeRight} {...grips.right.panHandlers}>
                  <View style={styles.edgeBarV} />
                </View>
                <View style={styles.edgeTop} {...grips.top.panHandlers}>
                  <View style={styles.edgeBarH} />
                </View>
                <View style={styles.edgeBottom} {...grips.bottom.panHandlers}>
                  <View style={styles.edgeBarH} />
                </View>
                <View style={[styles.corner, styles.cornerTL]} {...grips.tl.panHandlers} />
                <View style={[styles.corner, styles.cornerTR]} {...grips.tr.panHandlers} />
                <View style={[styles.corner, styles.cornerBL]} {...grips.bl.panHandlers} />
                <View style={[styles.corner, styles.cornerBR]} {...grips.br.panHandlers} />
              </View>
            </>
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
          <Pressable style={[styles.primary, { backgroundColor: accent }]} onPress={() => onConfirm(normalizeCrop(cropRef.current))}>
            <Text style={styles.primaryText}>使用这个裁剪</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createCropStyles(palette: Palette) {
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
    overflow: 'visible',
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
  shade: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  edgeLeft: {
    position: 'absolute',
    left: -18,
    top: 16,
    bottom: 16,
    width: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  edgeRight: {
    position: 'absolute',
    right: -18,
    top: 16,
    bottom: 16,
    width: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  edgeTop: {
    position: 'absolute',
    top: -18,
    left: 16,
    right: 16,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  edgeBottom: {
    position: 'absolute',
    bottom: -18,
    left: 16,
    right: 16,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  edgeBarV: {
    width: 4,
    height: 28,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
  },
  edgeBarH: {
    width: 28,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
  },
  corner: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: '#FFFFFF',
  },
  cornerTL: {
    left: -2,
    top: -2,
    borderLeftWidth: 3,
    borderTopWidth: 3,
  },
  cornerTR: {
    right: -2,
    top: -2,
    borderRightWidth: 3,
    borderTopWidth: 3,
  },
  cornerBL: {
    left: -2,
    bottom: -2,
    borderLeftWidth: 3,
    borderBottomWidth: 3,
  },
  cornerBR: {
    right: -2,
    bottom: -2,
    borderRightWidth: 3,
    borderBottomWidth: 3,
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
