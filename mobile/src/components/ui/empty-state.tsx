/**
 * Nothing to show, and what to do about it.
 *
 * An empty screen is an invitation to act, so this always takes a headline that
 * states the situation plainly and, wherever an action exists, a button that
 * performs it. No illustration: this is a utility the user opens twenty times a
 * week, and a large friendly drawing gets tiresome by the third day.
 *
 * The one piece of motion is a single rise-and-fade on mount — one orchestrated
 * moment rather than a stagger, gated behind `useReducedMotion`.
 */

import { useEffect, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from '@/components/ui/pressable-scale';
import { layout, motion, palette, radius, spacing, type } from '@/theme';

/** Entrance travel, in px. Derived locally. */
const RISE = 12;
const ICON_SIZE = 30;

export type EmptyStateProps = {
  /** States the situation: "No deals above 60% right now". */
  headline: string;
  /** One line on what to do or why it is empty. */
  caption?: string;
  /** Ionicons glyph. Rendered in a quiet circle above the headline. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Button label. The button appears only when `onAction` is given too. */
  actionLabel?: string;
  onAction?: () => void;
  /** Extra content under the action, e.g. a filter summary. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function EmptyState({
  headline,
  caption,
  icon = 'pricetag-outline',
  actionLabel,
  onAction,
  children,
  style,
}: EmptyStateProps) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = withSpring(1, motion.gentle);
  }, [progress, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: interpolate(progress.value, [0, 1], [RISE, 0]) }],
  }));

  return (
    <Animated.View style={[styles.root, animatedStyle, style]}>
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={ICON_SIZE} color={palette.textMuted} />
      </View>

      <Text accessibilityRole="header" maxFontSizeMultiplier={1.3} style={styles.headline}>
        {headline}
      </Text>

      {caption ? (
        <Text maxFontSizeMultiplier={1.4} style={styles.caption}>
          {caption}
        </Text>
      ) : null}

      {actionLabel && onAction ? (
        <PressableScale haptic="selection" onPress={onAction} style={styles.action}>
          <Text maxFontSizeMultiplier={1.2} style={styles.actionLabel}>
            {actionLabel}
          </Text>
        </PressableScale>
      ) : null}

      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: layout.screenPadding,
    gap: spacing.md,
  },
  iconWrap: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: palette.surfaceRaised,
    marginBottom: spacing.xs,
  },
  headline: {
    ...type.title,
    color: palette.textPrimary,
    textAlign: 'center',
  },
  caption: {
    ...type.body,
    color: palette.textSecondary,
    textAlign: 'center',
    maxWidth: layout.proseMaxWidth,
  },
  action: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.pill,
    backgroundColor: palette.ink,
  },
  actionLabel: {
    ...type.label,
    color: palette.textInverse,
  },
});
