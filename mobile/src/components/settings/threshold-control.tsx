/**
 * The discount threshold that fires an alert (spec §7).
 *
 * A bare percentage is hard to calibrate, so the control states the consequence
 * underneath it in the user's own terms — at 60% a ₹500 shirt has to fall to
 * ₹200 before the phone rings. That worked example is what makes the difference
 * between 55% and 65% legible; the number alone is not.
 *
 * The reading is large and tabular because it changes live under a dragging
 * thumb, and a jumping, reflowing number under your finger reads as a bug.
 */

import { StyleSheet, Text, View } from 'react-native';

import { Slider } from '@/components/ui/slider';
import { rupees } from '@/lib/format';
import { palette, spacing, type } from '@/theme';

/** The worked example's list price. A round number the user can do sums with. */
const EXAMPLE_MRP = 500;

export type ThresholdControlProps = {
  /** 0..1, straight from `Prefs.threshold`. */
  value: number;
  onChange: (next: number) => void;
  accent: string;
};

export function ThresholdControl({ value, onChange, accent }: ThresholdControlProps) {
  const percent = Math.round(value * 100);
  const trigger = EXAMPLE_MRP * (1 - value);

  return (
    <View style={styles.root}>
      <View style={styles.readout}>
        <Text maxFontSizeMultiplier={1.2} style={styles.value}>
          {percent}%
        </Text>
        <Text maxFontSizeMultiplier={1.3} style={styles.unit}>
          off or better
        </Text>
      </View>

      <Slider
        value={percent}
        min={20}
        max={90}
        step={5}
        accent={accent}
        accessibilityLabel="Discount threshold for alerts"
        onChange={(next) => onChange(next / 100)}
      />

      <Text maxFontSizeMultiplier={1.4} style={styles.example}>
        A {rupees(EXAMPLE_MRP)} item has to drop to {rupees(trigger)} before Bachat
        notifies you. Recorded lows always notify, whatever this is set to.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.xs,
  },
  readout: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  value: {
    ...type.price,
    color: palette.textPrimary,
  },
  unit: {
    ...type.body,
    color: palette.textSecondary,
  },
  example: {
    ...type.caption,
    color: palette.textSecondary,
  },
});
