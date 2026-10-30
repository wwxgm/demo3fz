import { useMemo } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { WatermarkSettings } from './runtime';
import { useTheme, type Palette } from './theme';

type Props = {
  value: WatermarkSettings;
  onChange: (next: WatermarkSettings) => void;
  embedded?: boolean;
  disabled?: boolean;
};

export function WatermarkForm({ value, onChange, embedded, disabled }: Props) {
  const { color: accent, palette } = useTheme();
  const styles = useMemo(() => createWatermarkStyles(palette), [palette]);
  const patch = (part: Partial<WatermarkSettings>) => onChange({ ...value, ...part });

  return (
    <View style={[styles.box, embedded && styles.embedded]}>
      <View style={styles.row}>
        <Text style={styles.label}>添加水印</Text>
        <Switch
          disabled={disabled}
          value={value.enabled}
          onValueChange={(enabled) => {
            if (!enabled) {
              patch({ enabled: false });
              return;
            }
            patch({
              enabled: true,
              placeLeft: true,
              placeCenter: false,
            });
          }}
          trackColor={{ false: palette.switchOff, true: accent }}
        />
      </View>
      {value.enabled ? (
        <View style={styles.fields}>
          <TextInput
            value={value.text}
            onChangeText={(text) => patch({ text })}
            editable={!disabled}
            placeholder="南方小猴子"
            placeholderTextColor={palette.placeholder}
            style={styles.input}
          />
          <Stepper
            label="字号"
            value={String(value.fontSize)}
            disabled={disabled}
            onMinus={() => patch({ fontSize: Math.max(12, value.fontSize - 2) })}
            onPlus={() => patch({ fontSize: Math.min(48, value.fontSize + 2) })}
          />
          <Stepper
            label="透明度"
            value={`${Math.round(value.opacity * 100)}%`}
            disabled={disabled}
            onMinus={() => patch({ opacity: Math.max(0.1, Number((value.opacity - 0.05).toFixed(2))) })}
            onPlus={() => patch({ opacity: Math.min(0.5, Number((value.opacity + 0.05).toFixed(2))) })}
          />
          <View style={styles.row}>
            <Text style={styles.sub}>轻微移动</Text>
            <Switch
              disabled={disabled}
              value={value.move}
              onValueChange={(move) => patch({ move })}
              trackColor={{ false: palette.switchOff, true: accent }}
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.sub}>旁边</Text>
            <Switch
              disabled={disabled}
              value={value.placeLeft}
              onValueChange={(placeLeft) =>
                patch(placeLeft ? { placeLeft: true, placeCenter: false } : { placeLeft: false, placeCenter: true })
              }
              trackColor={{ false: palette.switchOff, true: accent }}
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.sub}>中央</Text>
            <Switch
              disabled={disabled}
              value={value.placeCenter}
              onValueChange={(placeCenter) =>
                patch(placeCenter ? { placeLeft: false, placeCenter: true } : { placeLeft: true, placeCenter: false })
              }
              trackColor={{ false: palette.switchOff, true: accent }}
            />
          </View>
          <Text style={styles.hint}>只显示一个位置，打开时默认在旁边。视频从第 2 秒出现，到第 6 秒隐藏。</Text>
        </View>
      ) : null}
    </View>
  );
}

function Stepper({
  label,
  value,
  disabled,
  onMinus,
  onPlus,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onMinus: () => void;
  onPlus: () => void;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => createWatermarkStyles(palette), [palette]);
  return (
    <View style={styles.row}>
      <Text style={styles.sub}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable disabled={disabled} onPress={onMinus} style={styles.step}>
          <Text style={styles.stepText}>-</Text>
        </Pressable>
        <Text style={styles.stepValue}>{value}</Text>
        <Pressable disabled={disabled} onPress={onPlus} style={styles.step}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createWatermarkStyles(palette: Palette) {
  return StyleSheet.create({
  box: {
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  embedded: {
    marginTop: 4,
    borderWidth: 0,
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  fields: {
    gap: 8,
    paddingBottom: 6,
  },
  row: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '600',
  },
  sub: {
    color: palette.text,
    fontSize: 15,
  },
  input: {
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: 12,
    color: palette.text,
    backgroundColor: palette.field,
    fontSize: 16,
  },
  hint: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  step: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.field,
  },
  stepText: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '700',
  },
  stepValue: {
    minWidth: 48,
    textAlign: 'center',
    color: palette.text,
    fontSize: 15,
  },
});
}
