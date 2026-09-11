/**
 * Loading placeholders.
 *
 * A slow opacity breath rather than a travelling shine. A sweep gradient across
 * a list of eight rows is eight animated gradients on a phone that is often a
 * budget Android, and the shine reads as decoration; a breath reads as "not
 * yet". `useReducedMotion` freezes it at rest rather than flickering.
 *
 * `SkeletonRow` matches `PriceRow`'s geometry exactly, so the list does not
 * visibly jump when real data lands.
 */

import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { layout, motion, palette, radius as radii, spacing } from '@/theme';

/** Opacity floor of the breath. Derived locally. */
const DIM = 0.45;

export type SkeletonProps = {
  width?: DimensionValue;
  height?: number;
  /** Corner radius. Defaults to `radius.xs`. */
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

export function Skeleton({
  width = '100%',
  height = 12,
  radius = radii.xs,
  style,
}: SkeletonProps) {
  const breath = useSharedValue(1);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) {
      breath.value = DIM;
      return;
    }
    breath.value = withRepeat(
      withTiming(DIM, {
        duration: motion.duration.pulse,
        easing: Easing.inOut(Easing.quad),
      }),
      -1,
      true
    );
  }, [breath, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: breath.value }));

  return (
    <Animated.View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      style={[styles.block, { width, height, borderRadius: radius }, animatedStyle, style]}
    />
  );
}

export type SkeletonRowProps = { style?: StyleProp<ViewStyle> };

/** A single loading price row, dimensioned to match `PriceRow`. */
export function SkeletonRow({ style }: SkeletonRowProps) {
  return (
    <View style={[styles.row, style]}>
      <Skeleton
        width={layout.retailerMark}
        height={layout.retailerMark}
        radius={layout.retailerMark * 0.28}
      />
      <View style={styles.body}>
        <Skeleton width="62%" height={13} />
        <Skeleton width="38%" height={11} />
      </View>
      <View style={styles.priceColumn}>
        <Skeleton width={72} height={20} />
        <Skeleton width={44} height={11} />
      </View>
    </View>
  );
}

export type SkeletonListProps = {
  /** How many rows to fake. Match what the screen usually shows. */
  count?: number;
  style?: StyleProp<ViewStyle>;
};

export function SkeletonList({ count = 5, style }: SkeletonListProps) {
  return (
    <View style={style}>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: palette.surfacePressed,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: layout.rowHeight,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: palette.surface,
  },
  body: {
    flex: 1,
    gap: spacing.sm,
  },
  priceColumn: {
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
});
