/**
 * The discount badge, and its honest sibling the period-low badge.
 *
 * Both refuse to render rather than overstate. `DiscountPill` rounds the
 * percentage **down** and returns null when there is no MRP to compare against;
 * `PeriodLowBadge` says "Lowest in 12 days" with the real N and disappears
 * entirely below two days of history, because spec §7 makes claiming a 30-day
 * low we cannot substantiate a hard failure, not a rounding choice.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { periodLowLabel } from '@/lib/format';
import { palette, radius, spacing, type } from '@/theme';

export type DiscountPillProps = {
  /** 0..1. Renders nothing at or below zero. */
  fraction: number | null;
  /** `solid` for a deal card, `soft` for a dense row. */
  variant?: 'solid' | 'soft';
  style?: StyleProp<ViewStyle>;
};

export function DiscountPill({ fraction, variant = 'soft', style }: DiscountPillProps) {
  if (fraction === null || !Number.isFinite(fraction) || fraction <= 0) return null;
  const percent = Math.floor(fraction * 100);
  if (percent < 1) return null;

  const solid = variant === 'solid';
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${percent} percent off`}
      style={[styles.pill, solid ? styles.solid : styles.soft, style]}
    >
      <Text maxFontSizeMultiplier={1.2} style={[styles.text, solid && styles.textSolid]}>
        {percent}% off
      </Text>
    </View>
  );
}

export type PeriodLowBadgeProps = {
  /** Real days of history held for this product. The N in "lowest in N days". */
  historyDays: number;
  style?: StyleProp<ViewStyle>;
};

export function PeriodLowBadge({ historyDays, style }: PeriodLowBadgeProps) {
  const label = periodLowLabel(historyDays);
  if (label === null) return null;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.pill, styles.soft, style]}
    >
      <Text maxFontSizeMultiplier={1.2} style={styles.text}>
        {label}
      </Text>
    </View>
  );
}

export type OutOfStockPillProps = {
  style?: StyleProp<ViewStyle>;
};

/** Says the one thing that disqualifies a retailer from winning (spec §8). */
export function OutOfStockPill({ style }: OutOfStockPillProps) {
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel="Out of stock"
      style={[styles.pill, styles.danger, style]}
    >
      <Text maxFontSizeMultiplier={1.2} style={[styles.text, styles.textDanger]}>
        Out of stock
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xxs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.xs,
  },
  soft: {
    backgroundColor: palette.saveWash,
  },
  solid: {
    backgroundColor: palette.save,
  },
  danger: {
    backgroundColor: palette.dangerWash,
  },
  text: {
    ...type.tag,
    color: palette.save,
  },
  textSolid: {
    color: palette.textInverse,
  },
  textDanger: {
    color: palette.danger,
  },
});
