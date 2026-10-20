import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { WatermarkSettings } from './runtime';

type Props = {
  value: WatermarkSettings;
  onChange: (next: WatermarkSettings) => void;
};

export function WatermarkForm({ value, onChange }: Props) {
  const patch = (part: Partial<WatermarkSettings>) => onChange({ ...value, ...part });

  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <Text style={styles.label}>添加水印</Text>
        <Switch
          value={value.enabled}
          onValueChange={(enabled) => patch({ enabled })}
          trackColor={{ false: 'rgba(255,255,255,0.15)', true: '#1F6FEB' }}
        />
      </View>
      {value.enabled ? (
        <View style={styles.fields}>
          <TextInput
            value={value.text}
            onChangeText={(text) => patch({ text })}
            placeholder="南方小猴子"
            placeholderTextColor="#6E8498"
            style={styles.input}
          />
          <Stepper
            label="字号"
            value={String(value.fontSize)}
            onMinus={() => patch({ fontSize: Math.max(12, value.fontSize - 2) })}
            onPlus={() => patch({ fontSize: Math.min(48, value.fontSize + 2) })}
          />
          <Stepper
            label="透明度"
            value={`${Math.round(value.opacity * 100)}%`}
            onMinus={() => patch({ opacity: Math.max(0.1, Number((value.opacity - 0.05).toFixed(2))) })}
            onPlus={() => patch({ opacity: Math.min(0.5, Number((value.opacity + 0.05).toFixed(2))) })}
          />
          <View style={styles.row}>
            <Text style={styles.sub}>轻微移动</Text>
            <Switch
              value={value.move}
              onValueChange={(move) => patch({ move })}
              trackColor={{ false: 'rgba(255,255,255,0.15)', true: '#1F6FEB' }}
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.sub}>左边</Text>
            <Switch
              value={value.placeLeft}
              onValueChange={(placeLeft) => patch({ placeLeft })}
              trackColor={{ false: 'rgba(255,255,255,0.15)', true: '#1F6FEB' }}
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.sub}>中央</Text>
            <Switch
              value={value.placeCenter}
              onValueChange={(placeCenter) => patch({ placeCenter })}
              trackColor={{ false: 'rgba(255,255,255,0.15)', true: '#1F6FEB' }}
            />
          </View>
          <Text style={styles.hint}>默认不加水印。勾选后文字在左边和中央，颜色很淡，并轻微挪动。</Text>
        </View>
      ) : null}
    </View>
  );
}

function Stepper({
  label,
  value,
  onMinus,
  onPlus,
}: {
  label: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.sub}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable onPress={onMinus} style={styles.step}>
          <Text style={styles.stepText}>-</Text>
        </Pressable>
        <Text style={styles.stepValue}>{value}</Text>
        <Pressable onPress={onPlus} style={styles.step}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 8,
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
    color: '#F4F7FB',
    fontSize: 16,
    fontWeight: '600',
  },
  sub: {
    color: '#F4F7FB',
    fontSize: 15,
  },
  input: {
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: 12,
    color: '#F4F7FB',
    backgroundColor: 'rgba(255,255,255,0.08)',
    fontSize: 16,
  },
  hint: {
    color: '#9BB0C5',
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
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  stepText: {
    color: '#F4F7FB',
    fontSize: 18,
    fontWeight: '700',
  },
  stepValue: {
    minWidth: 48,
    textAlign: 'center',
    color: '#F4F7FB',
    fontSize: 15,
  },
});
