/**
 * Quantity, minus and plus.
 *
 * The basket is edited constantly — this is the control the user touches most
 * after the mode switch — so it is a stepper rather than a number field: no
 * keyboard, no dismissal, no chance of typing "22" when you meant "2". The
 * count sits between the buttons in tabular figures so a column of them does
 * not jitter as quantities cross from one digit to two.
 *
 * Minus at 1 is disabled rather than hidden. A control that disappears under
 * the thumb is a control the user has to re-find.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from '@/components/ui/pressable-scale';
import { layout, palette, radius, spacing, type } from '@/theme';

const BUTTON = 32;

export type StepperProps = {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** What is being counted, for the screen reader: 'Amul Taaza 500 ml'. */
  itemLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function Stepper({
  value,
  onChange,
  min = 1,
  max = 99,
  itemLabel,
  style,
}: StepperProps) {
  const suffix = itemLabel ? ` of ${itemLabel}` : '';

  return (
    <View style={[styles.root, style]}>
      <PressableScale
        haptic="selection"
        activeScale={0.9}
        disabled={value <= min}
        onPress={() => onChange(Math.max(min, value - 1))}
        accessibilityLabel={`One fewer${suffix}`}
        style={styles.button}
      >
        <Ionicons
          name="remove"
          size={16}
          color={value <= min ? palette.textMuted : palette.textPrimary}
        />
      </PressableScale>

      <Text maxFontSizeMultiplier={1.2} style={styles.count}>
        {value}
      </Text>

      <PressableScale
        haptic="selection"
        activeScale={0.9}
        disabled={value >= max}
        onPress={() => onChange(Math.min(max, value + 1))}
        accessibilityLabel={`One more${suffix}`}
        style={styles.button}
      >
        <Ionicons
          name="add"
          size={16}
          color={value >= max ? palette.textMuted : palette.textPrimary}
        />
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    backgroundColor: palette.surfaceRaised,
    borderWidth: layout.hairline,
    borderColor: palette.line,
    padding: spacing.xxs,
  },
  button: {
    width: BUTTON,
    height: BUTTON,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
  },
  count: {
    ...type.priceSmall,
    color: palette.textPrimary,
    minWidth: 26,
    textAlign: 'center',
  },
});
